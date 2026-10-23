import { createInterface, type Interface } from "node:readline/promises";
import pc from "picocolors";
import type { Agent } from "../agent/agent.js";
import type { Decision, PermissionRequest, Permissions } from "../agent/permissions.js";
import type { Usage } from "../types.js";
import type { Renderer } from "./render.js";

const HELP = `Commands:
  /help           Show this help
  /clear          Start a new conversation
  /model [name]   Show or switch the model (same provider)
  /yolo           Toggle auto-approve for writes and commands
  /usage          Show token usage for this session
  /exit           Quit
End a line with \\ to continue typing on the next line. Ctrl+C interrupts the agent.`;

export interface ReplDeps {
  agent: Agent;
  permissions: Permissions;
  renderer: Renderer;
  setModel(model: string): void;
}

export class Repl {
  private rl!: Interface;
  private running?: AbortController;
  private lastSigint = 0;

  constructor(private readonly deps: ReplDeps) {}

  readonly askPermission = async (req: PermissionRequest): Promise<Decision> => {
    this.deps.renderer.pause();
    const always = req.alwaysKey ? `, ${pc.bold("a")}lways${pc.dim(` (${req.alwaysKey.replace(/^bash:/, "")}*)`)}` : "";
    const verb = req.tool.kind === "exec" ? "Run" : "Allow";
    while (true) {
      let answer: string;
      try {
        answer = (await this.rl.question(`${pc.yellow("?")} ${verb} ${pc.bold(req.tool.name)}? ${pc.bold("y")}es${always}, ${pc.bold("n")}o: `, {
          signal: this.running?.signal,
        })).trim().toLowerCase();
      } catch {
        return "deny"; // interrupted
      }
      if (answer === "y" || answer === "yes" || answer === "") return "allow";
      if ((answer === "a" || answer === "always") && req.alwaysKey) return "allow_always";
      if (answer === "n" || answer === "no") return "deny";
    }
  };

  async start(banner: string): Promise<void> {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 200 });
    this.rl.on("SIGINT", () => this.onSigint());
    this.rl.on("close", () => {
      if (!this.running) process.exit(0);
    });
    console.log(banner);
    console.log(pc.dim("Type /help for commands.\n"));

    while (true) {
      const input = await this.readInput();
      if (!input) continue;
      if (input.startsWith("/")) {
        await this.command(input);
        continue;
      }
      await this.runTurn(input);
    }
  }

  private async readInput(): Promise<string> {
    let text = "";
    let prompt = `${pc.green("❯")} `;
    while (true) {
      const line = await this.rl.question(prompt);
      if (line.endsWith("\\")) {
        text += line.slice(0, -1) + "\n";
        prompt = `${pc.dim("…")} `;
        continue;
      }
      return (text + line).trim();
    }
  }

  private async runTurn(input: string): Promise<void> {
    const { agent, renderer } = this.deps;
    const before = { ...agent.totalUsage };
    this.running = new AbortController();
    renderer.startTurn();
    try {
      await agent.run(input, renderer.events, this.running.signal);
    } catch (err) {
      renderer.error((err as Error).message);
    } finally {
      const aborted = this.running.signal.aborted;
      this.running = undefined;
      renderer.endTurn(diffUsage(agent.totalUsage, before));
      if (aborted) renderer.info("Interrupted. What should I do instead?");
    }
  }

  private onSigint(): void {
    if (this.running) {
      this.running.abort();
      return;
    }
    const now = Date.now();
    if (now - this.lastSigint < 2000) process.exit(0);
    this.lastSigint = now;
    this.rl.write(null, { ctrl: true, name: "u" });
    console.log(pc.dim("\n(Press Ctrl+C again to exit)"));
    this.rl.prompt();
  }

  private async command(input: string): Promise<void> {
    const [cmd, ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    const { agent, permissions, renderer } = this.deps;
    switch (cmd) {
      case "help":
        console.log(HELP);
        break;
      case "clear":
        agent.clear();
        renderer.info("Conversation cleared.");
        break;
      case "model":
        if (arg) this.deps.setModel(arg);
        renderer.info(`Model: ${agent.provider.name}/${agent.provider.model}`);
        break;
      case "yolo":
        permissions.mode = permissions.mode === "auto" ? "ask" : "auto";
        renderer.info(permissions.mode === "auto" ? "Auto-approve ON: writes and commands run without asking." : "Auto-approve OFF.");
        break;
      case "usage": {
        const u = agent.totalUsage;
        renderer.info(`Session: ${u.inputTokens} input, ${u.outputTokens} output, ${u.cacheReadTokens} cache read, ${u.cacheWriteTokens} cache write tokens.`);
        break;
      }
      case "exit":
      case "quit":
        process.exit(0);
      default:
        renderer.error(`Unknown command /${cmd}. Try /help.`);
    }
  }
}

function diffUsage(after: Usage, before: Usage): Usage {
  return {
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    cacheReadTokens: (after.cacheReadTokens ?? 0) - (before.cacheReadTokens ?? 0),
  };
}
