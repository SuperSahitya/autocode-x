import pc from "picocolors";
import type { AgentEvents } from "../agent/agent.js";
import type { ToolOutput } from "../tools/types.js";
import type { ToolCallPart, Usage } from "../types.js";

const MAX_DIFF_LINES = 40;
const MAX_OUTPUT_PREVIEW = 6;

class Spinner {
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private static readonly FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  constructor(private readonly out: NodeJS.WriteStream) {}

  start(label: string): void {
    if (!this.out.isTTY || this.timer) return;
    const started = Date.now();
    this.timer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      this.out.write(`\r${pc.cyan(Spinner.FRAMES[this.frame++ % Spinner.FRAMES.length]!)} ${pc.dim(`${label} ${secs}s`)}\x1b[K`);
    }, 80);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.out.write("\r\x1b[K");
  }
}

export const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// In headless mode text goes to stdout and tool activity to stderr.
export class Renderer {
  private atLineStart = true;
  private readonly spinner: Spinner;

  constructor(
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly log: NodeJS.WriteStream = process.stdout,
  ) {
    this.spinner = new Spinner(log);
  }

  readonly events: AgentEvents = {
    onText: (delta) => {
      this.spinner.stop();
      this.out.write(delta);
      this.atLineStart = delta.endsWith("\n");
    },
    onToolStart: (call, summary) => {
      this.spinner.stop();
      this.newline();
      this.log.write(`${pc.cyan("●")} ${pc.bold(call.name)}${summary ? pc.dim(`(${oneLine(summary, 100)})`) : ""}\n`);
    },
    onToolEnd: (call, result) => {
      this.log.write(this.formatResult(call, result));
      this.spinner.start("Thinking");
    },
  };

  startTurn(): void {
    this.spinner.start("Thinking");
  }

  endTurn(usage?: Usage): void {
    this.spinner.stop();
    this.newline();
    if (usage) {
      const cached = usage.cacheReadTokens ? `, ${formatTokens(usage.cacheReadTokens)} cached` : "";
      this.log.write(pc.dim(`↑ ${formatTokens(usage.inputTokens)} ↓ ${formatTokens(usage.outputTokens)} tokens${cached}\n`));
    }
  }

  pause(): void {
    this.spinner.stop();
    this.newline();
  }

  error(message: string): void {
    this.spinner.stop();
    this.newline();
    this.log.write(pc.red(`✖ ${message}\n`));
  }

  info(message: string): void {
    this.newline();
    this.log.write(pc.dim(`${message}\n`));
  }

  private newline(): void {
    if (!this.atLineStart) this.out.write("\n");
    this.atLineStart = true;
  }

  private formatResult(call: ToolCallPart, r: ToolOutput): string {
    const gutter = pc.dim("  ⎿ ");
    const indent = "    ";
    if (r.isError) {
      const lines = r.output.trim().split("\n");
      return gutter + pc.red(lines.slice(0, MAX_OUTPUT_PREVIEW).join(`\n${indent}`)) + more(lines.length - MAX_OUTPUT_PREVIEW) + "\n";
    }
    if (r.display) {
      if (!r.display.includes("\n@@")) return gutter + pc.dim(r.display) + "\n";
      return colorDiff(r.display).map((l) => indent + l).join("\n") + "\n";
    }
    const lines = r.output.trimEnd().split("\n");
    switch (call.name) {
      case "read_file":
        return gutter + pc.dim(`Read ${lines.filter((l) => /^\s*\d+\t/.test(l)).length} lines`) + "\n";
      case "glob":
      case "grep":
      case "list_dir":
        return gutter + pc.dim(r.output.startsWith("No ") ? r.output : `${lines.length} result${lines.length === 1 ? "" : "s"}`) + "\n";
      default: {
        const tail = lines.slice(-MAX_OUTPUT_PREVIEW);
        return gutter + pc.dim(tail.map((l) => oneLine(l, 160)).join(`\n${indent}`)) + "\n";
      }
    }
  }
}

function colorDiff(diff: string): string[] {
  const lines = diff
    .trimEnd()
    .split("\n")
    .filter((l) => !l.startsWith("---") && !l.startsWith("+++") && l !== "\\ No newline at end of file");
  const shown = lines.slice(0, MAX_DIFF_LINES).map((l) => {
    if (l.startsWith("+")) return pc.green(l);
    if (l.startsWith("-")) return pc.red(l);
    if (l.startsWith("@@")) return pc.cyan(l);
    return pc.dim(l);
  });
  if (lines.length > MAX_DIFF_LINES) shown.push(pc.dim(`... ${lines.length - MAX_DIFF_LINES} more diff lines`));
  return shown;
}

const more = (n: number) => (n > 0 ? pc.dim(`\n    ... ${n} more lines`) : "");
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s*\n\s*/g, " ⏎ ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
