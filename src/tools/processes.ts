import { spawn, type ChildProcess } from "node:child_process";
import { killTree } from "../util/process.js";
import { stripAnsi } from "../util/text.js";
import { shellArgs, type ShellInfo } from "./shell.js";

const MAX_BUFFER = 1024 * 1024;

export interface BackgroundProcess {
  id: string;
  command: string;
  child: ChildProcess;
  buffer: string;
  readPos: number;
  exitCode: number | null;
  running: boolean;
}

export class ProcessManager {
  private readonly procs = new Map<string, BackgroundProcess>();
  private nextId = 1;

  start(command: string, shell: ShellInfo, cwd: string, env: NodeJS.ProcessEnv): BackgroundProcess {
    const child = spawn(shell.path, shellArgs(shell, command), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const proc: BackgroundProcess = {
      id: `bg${this.nextId++}`,
      command,
      child,
      buffer: "",
      readPos: 0,
      exitCode: null,
      running: true,
    };
    const append = (b: Buffer) => {
      proc.buffer += stripAnsi(b.toString("utf8"));
      if (proc.buffer.length > MAX_BUFFER) {
        const drop = proc.buffer.length - MAX_BUFFER;
        proc.buffer = proc.buffer.slice(drop);
        proc.readPos = Math.max(0, proc.readPos - drop);
      }
    };
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    child.on("error", (err) => append(Buffer.from(`\n${err.message}\n`)));
    child.on("close", (code) => {
      proc.running = false;
      proc.exitCode = code;
    });
    this.procs.set(proc.id, proc);
    return proc;
  }

  get(id: string): BackgroundProcess | undefined {
    return this.procs.get(id);
  }

  list(): BackgroundProcess[] {
    return [...this.procs.values()];
  }

  /** Output produced since the last read. */
  readNew(proc: BackgroundProcess): string {
    const out = proc.buffer.slice(proc.readPos);
    proc.readPos = proc.buffer.length;
    return out;
  }

  /** Resolves once new output arrives, the process exits, or the timeout passes. */
  waitForOutput(proc: BackgroundProcess, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!proc.running || proc.buffer.length > proc.readPos) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        proc.child.stdout?.off("data", onData);
        proc.child.stderr?.off("data", onData);
        proc.child.off("close", done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      // let a burst of output finish arriving before returning
      const onData = () => setTimeout(done, 200);
      const timer = setTimeout(done, timeoutMs);
      proc.child.stdout?.on("data", onData);
      proc.child.stderr?.on("data", onData);
      proc.child.once("close", done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  kill(proc: BackgroundProcess): void {
    if (proc.running) killTree(proc.child.pid);
  }

  killAll(): void {
    for (const proc of this.procs.values()) if (proc.running) killTree(proc.child.pid, true);
  }
}
