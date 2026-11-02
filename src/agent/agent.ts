import { ProviderError, backoff, sleep } from "../providers/sse.js";
import type { ToolRegistry } from "../tools/index.js";
import { ProcessManager } from "../tools/processes.js";
import type { ShellInfo } from "../tools/shell.js";
import type { Tool, ToolContext, ToolOutput } from "../tools/types.js";
import type { Checkpoint, Checkpoints } from "../session/checkpoints.js";
import type { Message, Provider, StopReason, TextPart, ToolCallPart, ToolResultPart, Usage } from "../types.js";
import type { Permissions } from "./permissions.js";

const MAX_STREAM_RETRIES = 3;

export interface AgentEvents {
  onText?(delta: string): void;
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
  searxngUrl?: string;
  checkpoints?: Checkpoints;
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
  readonly processes = new ProcessManager();
  readonly checkpoints: Checkpoint[] = [];
  private readonly fileState = new Map<string, number>();
  private turn?: TurnState;
  private checkpointNoticeShown = false;

  constructor(private readonly opts: AgentOptions) {
    this.provider = opts.provider;
  }

  dispose(): void {
    this.processes.killAll();
  }

  clear(): void {
    this.messages.length = 0;
    this.checkpoints.length = 0;
    this.fileState.clear();
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
    // files changed under the agent; make it read them again before editing
    this.fileState.clear();
    this.opts.onTurnEnd?.();
    return { checkpoint, files };
  }

  async run(userText: string, events: AgentEvents = {}, signal = new AbortController().signal): Promise<void> {
    const last = this.messages.at(-1);
    this.turn = {
      label: userText,
      messageCount: this.messages.length,
      lastPartCount: last?.role === "user" ? last.content.length : undefined,
      checkpointed: false,
    };
    try {
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

    for (let step = 0; step < maxSteps; step++) {
      const text: TextPart = { type: "text", text: "" };
      const calls: ToolCallPart[] = [];

      try {
        this.countRequest();
        for await (const ev of this.provider.stream({
          system: this.opts.system,
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
            events.onStepEnd?.(ev.usage, ev.stopReason);
          }
        }
      } catch (err) {
        if (!signal.aborted && err instanceof ProviderError && err.retryable && streamRetries < MAX_STREAM_RETRIES) {
          // tools only run after a complete response, so repeating the call can't repeat any work
          streamRetries++;
          events.onNotice?.(`${err.message} Retrying (${streamRetries}/${MAX_STREAM_RETRIES}).`);
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

function safeSummarize(tool: Tool, input: unknown): string {
  try {
    return tool.summarize(input);
  } catch {
    return "";
  }
}
