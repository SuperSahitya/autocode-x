import { ProviderError, backoff, sleep } from "../providers/sse.js";
import type { ToolRegistry } from "../tools/index.js";
import { ProcessManager } from "../tools/processes.js";
import type { ShellInfo } from "../tools/shell.js";
import type { Tool, ToolContext, ToolOutput } from "../tools/types.js";
import type { Checkpoint, Checkpoints } from "../session/checkpoints.js";
import type { Message, Provider, StopReason, TextPart, ToolCallPart, ToolResultPart, Usage } from "../types.js";
import {
  DEFAULT_CONTEXT_LIMIT,
  SUMMARY_SYSTEM,
  buildSummaryMessage,
  estimateMessages,
  estimateTokens,
  findSplit,
  isContextOverflow,
  renderTranscript,
  trimToolOutputs,
} from "./context.js";
import type { Permissions } from "./permissions.js";

// matches what postWithRetry allows for a failed request, since a dropped stream is no less likely to recover
const MAX_STREAM_RETRIES = 5;

// shares of the context limit
const TRIM_AT = 0.5;
const TRIM_AGAIN_AFTER = 0.1;
const COMPACT_AT = 0.8;
const KEEP_AFTER_COMPACT = 0.2;
const MIN_WORTH_SUMMARIZING = 0.1;

const SUMMARY_MAX_TOKENS = 2000;

export interface AgentEvents {
  onText?(delta: string): void;
  /** the text so far won't be kept, because the response failed and is being requested again */
  onTextDiscarded?(): void;
  onToolStart?(call: ToolCallPart, summary: string): void;
  onToolOutput?(call: ToolCallPart, chunk: string): void;
  onToolEnd?(call: ToolCallPart, result: ToolOutput): void;
  onStepEnd?(usage: Usage, stopReason: StopReason): void;
  /** non-fatal problems worth showing, e.g. checkpoints being unavailable */
  onNotice?(message: string): void;
}

export interface AgentOptions {
  provider: Provider;
  tools: ToolRegistry;
  permissions: Permissions;
  system: string;
  cwd: string;
  shell: ShellInfo;
  maxTokens?: number;
  maxSteps?: number;
  maxStreamRetries?: number;
  searxngUrl?: string;
  checkpoints?: Checkpoints;
  /** tokens to work within; keeps requests small even when the model's window is much larger */
  contextLimit?: number;
  /** runs once before the first request, returning extra system prompt, e.g. a map of the code */
  projectContext?(signal: AbortSignal, onNotice: (message: string) => void): Promise<string>;
  /** called after every run, e.g. to save the session */
  onTurnEnd?(): void;
}

export interface AgentState {
  messages: Message[];
  usage: Usage;
  checkpoints: Checkpoint[];
}

interface TurnState {
  label: string;
  messageCount: number;
  lastPartCount?: number;
  compacted?: boolean;
  checkpointed: boolean;
}

interface PreparedCall {
  call: ToolCallPart;
  tool?: Tool;
  input?: unknown;
  error?: string;
  summary: string;
}

export class Agent {
  readonly messages: Message[] = [];
  readonly totalUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
  provider: Provider;
  contextLimit: number;
  readonly processes = new ProcessManager();
  readonly checkpoints: Checkpoint[] = [];
  private readonly fileState = new Map<string, number>();
  private turn?: TurnState;
  private turnCount = 0;
  private checkpointNoticeShown = false;
  /** what the API reported for the last request, which beats estimating */
  private lastRequest?: { tokens: number; messageCount: number };
  private trimAgainAt = 0;
  private system: string;
  private projectContextLoaded = false;

  constructor(private readonly opts: AgentOptions) {
    this.provider = opts.provider;
    this.contextLimit = opts.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    this.system = opts.system;
  }

  dispose(): void {
    this.processes.killAll();
  }

  clear(): void {
    this.messages.length = 0;
    this.checkpoints.length = 0;
    this.fileState.clear();
    this.resetContextTracking();
  }

  /** Tokens the next request would use. */
  contextTokens(): number {
    const { lastRequest } = this;
    if (lastRequest?.tokens) return lastRequest.tokens + estimateMessages(this.messages.slice(lastRequest.messageCount));
    return estimateTokens(this.system) + estimateTokens(JSON.stringify(this.opts.tools.specs())) + estimateMessages(this.messages);
  }

  /**
   * Summarize older messages into one, keeping the recent ones. auto keeps a larger tail and skips
   * the request when there's too little to gain. Returns undefined when nothing was compacted.
   */
  async compact(
    events: AgentEvents = {},
    signal = new AbortController().signal,
    auto = false,
  ): Promise<{ before: number; after: number } | undefined> {
    const split = findSplit(this.messages, auto ? this.contextLimit * KEEP_AFTER_COMPACT : 0);
    if (split === undefined) return undefined;
    const head = this.messages.slice(0, split);
    if (auto && estimateMessages(head) < this.contextLimit * MIN_WORTH_SUMMARIZING) return undefined;

    const before = this.contextTokens();
    let summary = "";
    try {
      summary = await this.summarize(head, events, signal);
    } catch (err) {
      if (signal.aborted) return undefined;
      events.onNotice?.(`Couldn't summarize the conversation (${(err as Error).message}). Keeping a list of requests and changed files instead.`);
    }
    this.messages.splice(0, split, { role: "user", content: [{ type: "text", text: buildSummaryMessage(head, summary) }] });
    this.shiftCheckpoints(split);
    // the file contents it read are gone, so it has to read again before editing
    this.fileState.clear();
    this.resetContextTracking();

    const after = this.contextTokens();
    events.onNotice?.(`Compacted the conversation: ~${formatTokens(before)} to ~${formatTokens(after)} tokens.`);
    this.opts.onTurnEnd?.();
    return { before, after };
  }

  state(): AgentState {
    return { messages: this.messages, usage: this.totalUsage, checkpoints: this.checkpoints };
  }

  load(state: AgentState): void {
    this.messages.splice(0, this.messages.length, ...state.messages);
    this.checkpoints.splice(0, this.checkpoints.length, ...state.checkpoints);
    Object.assign(this.totalUsage, state.usage);
  }

  /**
   * Restore files to the most recent checkpoint and drop the turn that followed it from the conversation.
   * Returns undefined when there is nothing to undo.
   */
  async undo(): Promise<{ checkpoint: Checkpoint; files: string[] } | undefined> {
    const checkpoint = this.checkpoints.pop();
    if (!checkpoint || !this.opts.checkpoints) return undefined;
    const files = await this.opts.checkpoints.restore(checkpoint.commit);
    this.messages.length = checkpoint.messageCount;
    const last = this.messages.at(-1);
    if (checkpoint.lastPartCount !== undefined && last?.role === "user") last.content.length = checkpoint.lastPartCount;
    if (checkpoint.compacted) {
      // the turn is part of the summary and can't be cut out of it, so say that it no longer applies
      const label = checkpoint.label.replace(/\s+/g, " ").slice(0, 100);
      this.pushUser([{ type: "text", text: `[The user ran /undo: files are back to how they were before "${label}". The summary may describe work that no longer exists, so check the files.]` }]);
    }
    // files changed under the agent; make it read them again before editing
    this.fileState.clear();
    this.resetContextTracking();
    this.opts.onTurnEnd?.();
    return { checkpoint, files };
  }

  async run(userText: string, events: AgentEvents = {}, signal = new AbortController().signal): Promise<void> {
    const last = this.messages.at(-1);
    this.turnCount++;
    this.turn = {
      label: userText,
      messageCount: this.messages.length,
      lastPartCount: last?.role === "user" ? last.content.length : undefined,
      checkpointed: false,
    };
    try {
      await this.loadProjectContext(events, signal);
      await this.loop(userText, events, signal);
    } finally {
      this.turn = undefined;
      this.opts.onTurnEnd?.();
    }
  }

  private async loop(userText: string, events: AgentEvents, signal: AbortSignal): Promise<void> {
    this.pushUser([{ type: "text", text: userText }]);
    const maxSteps = this.opts.maxSteps ?? 100;
    let streamRetries = 0;
    let overflowHandled = false;

    for (let step = 0; step < maxSteps; step++) {
      const text: TextPart = { type: "text", text: "" };
      const calls: ToolCallPart[] = [];

      await this.manageContext(events, signal);
      if (signal.aborted) return;
      const messageCount = this.messages.length;

      try {
        this.countRequest();
        for await (const ev of this.provider.stream({
          system: this.system,
          messages: this.messages,
          tools: this.opts.tools.specs(),
          maxTokens: this.opts.maxTokens ?? 16_000,
          signal,
          onRetry: (message) => {
            this.countRequest();
            events.onNotice?.(message);
          },
          onWait: events.onNotice,
        })) {
          if (ev.type === "text") {
            text.text += ev.delta;
            events.onText?.(ev.delta);
          } else if (ev.type === "tool_call") {
            calls.push(ev.call);
          } else {
            this.addUsage(ev.usage);
            this.lastRequest = {
              tokens: ev.usage.inputTokens + (ev.usage.cacheReadTokens ?? 0) + (ev.usage.cacheWriteTokens ?? 0),
              messageCount,
            };
            events.onStepEnd?.(ev.usage, ev.stopReason);
          }
        }
      } catch (err) {
        // the real limit turned out to be lower than we thought
        if (!signal.aborted && !overflowHandled && isContextOverflow(err)) {
          overflowHandled = true;
          trimToolOutputs(this.messages);
          if (await this.compact(events, signal)) {
            step--;
            continue;
          }
        }
        const maxStreamRetries = this.opts.maxStreamRetries ?? MAX_STREAM_RETRIES;
        if (!signal.aborted && err instanceof ProviderError && err.retryable && streamRetries < maxStreamRetries) {
          // tools only run after a complete response, so repeating the call can't repeat any work
          streamRetries++;
          if (text.text) events.onTextDiscarded?.();
          events.onNotice?.(`${err.message.replace(/\.?$/, ".")} Retrying (${streamRetries}/${maxStreamRetries}).`);
          await sleep(backoff(streamRetries), signal).catch(() => {});
          if (signal.aborted) return;
          step--;
          continue;
        }
        // drop partial tool calls, they'd have no results
        if (text.text) this.messages.push({ role: "assistant", content: [text] });
        if (signal.aborted) return;
        throw err;
      }
      streamRetries = 0;

      this.messages.push({ role: "assistant", content: [...(text.text ? [text] : []), ...calls] });
      if (calls.length === 0) return;

      const results = await this.runTools(calls, events, signal);
      this.pushUser(results.parts);
      if (results.stop || signal.aborted) return;
    }
    this.pushUser([{ type: "text", text: `[Stopped: reached the limit of ${maxSteps} steps for one request.]` }]);
  }

  private async runTools(calls: ToolCallPart[], events: AgentEvents, signal: AbortSignal) {
    const ctx: ToolContext = {
      cwd: this.opts.cwd,
      signal,
      shell: this.opts.shell,
      fileState: this.fileState,
      processes: this.processes,
      turn: this.turnCount,
      searxngUrl: this.opts.searxngUrl,
    };
    const prepared: PreparedCall[] = calls.map((call) => {
      const parsed = this.opts.tools.parse(call);
      if ("error" in parsed) return { call, error: parsed.error, summary: "" };
      return { call, tool: parsed.tool, input: parsed.input, summary: safeSummarize(parsed.tool, parsed.input) };
    });

    const results = new Map<string, ToolOutput>();
    let stop = false;
    const finish = (p: PreparedCall, r: ToolOutput) => {
      results.set(p.call.id, r);
      events.onToolEnd?.(p.call, r);
    };
    const runOne = async (p: PreparedCall) => {
      events.onToolStart?.(p.call, p.summary);
      if (p.error) return finish(p, { output: p.error, isError: true });
      if (stop || signal.aborted) return finish(p, { output: "Skipped.", isError: true });
      if (!(await this.opts.permissions.check(p.tool!, p.input, p.summary))) {
        stop = true;
        return finish(p, { output: "The user denied this tool call. Stop and wait for their instructions.", isError: true });
      }
      if (p.tool!.kind === "write" || p.tool!.kind === "exec") await this.ensureCheckpoint(events);
      const onOutput = events.onToolOutput && ((chunk: string) => events.onToolOutput!(p.call, chunk));
      finish(p, await this.opts.tools.execute(p.tool!, p.input, { ...ctx, onOutput }));
    };

    // read-only calls can't conflict, so run them concurrently
    if (prepared.every((p) => p.tool?.kind === "read" || p.error)) await Promise.all(prepared.map(runOne));
    else for (const p of prepared) await runOne(p);

    const parts: ToolResultPart[] = calls.map((c) => {
      const r = results.get(c.id) ?? { output: "Skipped.", isError: true };
      return { type: "tool_result", id: c.id, content: r.output, isError: r.isError };
    });
    return { parts, stop };
  }

  // one snapshot per turn, taken just before its first change, so read-only turns cost nothing
  private async ensureCheckpoint(events: AgentEvents): Promise<void> {
    const store = this.opts.checkpoints;
    const turn = this.turn;
    if (!store || !turn || turn.checkpointed) return;
    turn.checkpointed = true;
    try {
      const commit = await store.create(turn.label);
      if (commit) {
        this.checkpoints.push({
          commit,
          label: turn.label,
          createdAt: Date.now(),
          messageCount: turn.messageCount,
          lastPartCount: turn.lastPartCount,
          compacted: turn.compacted,
        });
        return;
      }
      if (!this.checkpointNoticeShown && store.disabledReason) events.onNotice?.(`Undo unavailable: ${store.disabledReason}.`);
    } catch (err) {
      if (!this.checkpointNoticeShown) events.onNotice?.(`Couldn't save a checkpoint: ${(err as Error).message}`);
    }
    this.checkpointNoticeShown = true;
  }

  // merge into a trailing user turn so roles keep alternating
  private pushUser(parts: (TextPart | ToolResultPart)[]): void {
    const last = this.messages.at(-1);
    if (last?.role === "user") last.content.push(...parts);
    else this.messages.push({ role: "user", content: parts });
  }

  // once per session and left unchanged after that, so it doesn't break the prompt cache
  private async loadProjectContext(events: AgentEvents, signal: AbortSignal): Promise<void> {
    if (this.projectContextLoaded || !this.opts.projectContext) return;
    this.projectContextLoaded = true;
    try {
      const context = await this.opts.projectContext(signal, (message) => events.onNotice?.(message));
      if (context) this.system += `\n\n${context}`;
    } catch {
      // only an aid; the agent can still explore without it
    }
  }

  // trims in batches rather than a little every step, so the prompt cache survives in between
  private async manageContext(events: AgentEvents, signal: AbortSignal): Promise<void> {
    const used = this.contextTokens();
    if (used < this.contextLimit * COMPACT_AT && used < Math.max(this.contextLimit * TRIM_AT, this.trimAgainAt)) return;
    if (trimToolOutputs(this.messages)) this.lastRequest = undefined;
    const trimmed = this.contextTokens();
    this.trimAgainAt = trimmed + this.contextLimit * TRIM_AGAIN_AFTER;
    if (trimmed >= this.contextLimit * COMPACT_AT) await this.compact(events, signal, true);
  }

  private async summarize(head: Message[], events: AgentEvents, signal: AbortSignal): Promise<string> {
    let summary = "";
    this.countRequest();
    for await (const ev of this.provider.stream({
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: renderTranscript(head) }] }],
      tools: [],
      maxTokens: SUMMARY_MAX_TOKENS,
      signal,
      onRetry: (message) => {
        this.countRequest();
        events.onNotice?.(message);
      },
      onWait: events.onNotice,
    })) {
      if (ev.type === "text") summary += ev.delta;
      else if (ev.type === "done") this.addUsage(ev.usage);
    }
    return summary.trim();
  }

  // compaction removed messages, so indexes into the conversation have moved
  private shiftCheckpoints(split: number): void {
    const shift = (c: { messageCount: number; lastPartCount?: number; compacted?: boolean }) => {
      if (c.messageCount > split) {
        c.messageCount += 1 - split;
      } else {
        c.messageCount = 1;
        c.lastPartCount = undefined;
        c.compacted = true;
      }
    };
    this.checkpoints.forEach(shift);
    if (this.turn) shift(this.turn);
  }

  private resetContextTracking(): void {
    this.lastRequest = undefined;
    this.trimAgainAt = 0;
  }

  private countRequest(): void {
    this.totalUsage.requests = (this.totalUsage.requests ?? 0) + 1;
  }

  private addUsage(u: Usage): void {
    this.totalUsage.inputTokens += u.inputTokens;
    this.totalUsage.outputTokens += u.outputTokens;
    this.totalUsage.cacheReadTokens! += u.cacheReadTokens ?? 0;
    this.totalUsage.cacheWriteTokens! += u.cacheWriteTokens ?? 0;
  }
}

const formatTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function safeSummarize(tool: Tool, input: unknown): string {
  try {
    return tool.summarize(input);
  } catch {
    return "";
  }
}
