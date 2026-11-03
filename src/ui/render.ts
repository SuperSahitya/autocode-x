import pc from "picocolors";
import type { AgentEvents } from "../agent/agent.js";
import type { Usage } from "../types.js";
import { formatToolHeader, formatToolResult, formatUsage } from "./format.js";

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

// Plain streaming output for headless mode: text to stdout, tool activity to stderr.
export class Renderer {
  private atLineStart = true;
  /** piped output waits for the whole response, as text already written can't be taken back */
  private held = "";
  private readonly spinner: Spinner;

  constructor(
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly log: NodeJS.WriteStream = process.stderr,
  ) {
    this.spinner = new Spinner(log);
  }

  readonly events: AgentEvents = {
    onText: (delta) => {
      this.spinner.stop();
      if (this.out.isTTY) this.write(delta);
      else this.held += delta;
    },
    onTextDiscarded: () => {
      this.held = "";
    },
    onStepEnd: () => this.flushHeld(),
    onToolStart: (call, summary) => {
      this.spinner.stop();
      this.newline();
      this.log.write(formatToolHeader(call, summary) + "\n");
    },
    onToolEnd: (call, result) => {
      this.log.write(formatToolResult(call, result) + "\n");
      this.spinner.start("Thinking");
    },
    onNotice: (message) => {
      this.spinner.stop();
      this.newline();
      this.log.write(pc.yellow(`! ${message}\n`));
    },
  };

  startTurn(): void {
    this.spinner.start("Thinking");
  }

  endTurn(usage?: Usage): void {
    this.spinner.stop();
    this.flushHeld();
    this.newline();
    if (usage) this.log.write(formatUsage(usage) + "\n");
  }

  error(message: string): void {
    this.spinner.stop();
    this.newline();
    this.log.write(pc.red(`✖ ${message}\n`));
  }

  private write(text: string): void {
    this.out.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  private flushHeld(): void {
    if (this.held) this.write(this.held);
    this.held = "";
  }

  private newline(): void {
    if (!this.atLineStart) this.out.write("\n");
    this.atLineStart = true;
  }
}
