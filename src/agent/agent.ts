import type { ToolRegistry } from "../tools/index.js";
import type { ShellInfo } from "../tools/shell.js";
import type { Tool, ToolContext, ToolOutput } from "../tools/types.js";
import type { Message, Provider, StopReason, TextPart, ToolCallPart, ToolResultPart, Usage } from "../types.js";
import type { Permissions } from "./permissions.js";

export interface AgentEvents {
  onText?(delta: string): void;
  onToolStart?(call: ToolCallPart, summary: string): void;
  onToolEnd?(call: ToolCallPart, result: ToolOutput): void;
  onStepEnd?(usage: Usage, stopReason: StopReason): void;
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
  readonly totalUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  provider: Provider;
  private readonly fileState = new Map<string, number>();

  constructor(private readonly opts: AgentOptions) {
    this.provider = opts.provider;
  }

  clear(): void {
    this.messages.length = 0;
    this.fileState.clear();
  }

  async run(userText: string, events: AgentEvents = {}, signal = new AbortController().signal): Promise<void> {
    this.pushUser([{ type: "text", text: userText }]);
    const maxSteps = this.opts.maxSteps ?? 100;

    for (let step = 0; step < maxSteps; step++) {
      const text: TextPart = { type: "text", text: "" };
      const calls: ToolCallPart[] = [];
      let stopReason: StopReason = "other";

      try {
        for await (const ev of this.provider.stream({
          system: this.opts.system,
          messages: this.messages,
          tools: this.opts.tools.specs(),
          maxTokens: this.opts.maxTokens ?? 16_000,
          signal,
        })) {
          if (ev.type === "text") {
            text.text += ev.delta;
            events.onText?.(ev.delta);
          } else if (ev.type === "tool_call") {
            calls.push(ev.call);
          } else {
            stopReason = ev.stopReason;
            this.addUsage(ev.usage);
            events.onStepEnd?.(ev.usage, ev.stopReason);
          }
        }
      } catch (err) {
        // drop partial tool calls, they'd have no results
        if (text.text) this.messages.push({ role: "assistant", content: [text] });
        if (signal.aborted) return;
        throw err;
      }

      this.messages.push({ role: "assistant", content: [...(text.text ? [text] : []), ...calls] });
      if (calls.length === 0) return;

      const results = await this.runTools(calls, events, signal);
      this.pushUser(results.parts);
      if (results.stop || signal.aborted) return;
    }
    this.pushUser([{ type: "text", text: `[Stopped: reached the limit of ${maxSteps} steps for one request.]` }]);
  }

  private async runTools(calls: ToolCallPart[], events: AgentEvents, signal: AbortSignal) {
    const ctx: ToolContext = { cwd: this.opts.cwd, signal, shell: this.opts.shell, fileState: this.fileState };
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
      finish(p, await this.opts.tools.execute(p.tool!, p.input, ctx));
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

  // merge into a trailing user turn so roles keep alternating
  private pushUser(parts: (TextPart | ToolResultPart)[]): void {
    const last = this.messages.at(-1);
    if (last?.role === "user") last.content.push(...parts);
    else this.messages.push({ role: "user", content: parts });
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
