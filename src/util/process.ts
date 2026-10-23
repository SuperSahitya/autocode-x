import { spawn, spawnSync } from "node:child_process";

export interface RunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
}

export function runProcess(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // closed stdin: prompts get EOF instead of hanging
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // own process group so the whole tree can be killed
      detached: process.platform !== "win32",
    });

    const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const collect = (b: Buffer) => {
      if (bytes < maxBytes) chunks.push(b);
      bytes += b.length;
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);

    let timedOut = false;
    let aborted = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, extra = "") => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ output: Buffer.concat(chunks).toString("utf8") + extra, exitCode, timedOut, aborted });
    };
    child.on("error", (err) => finish(null, `\n${err.message}`));
    child.on("close", (code) => finish(code));
  });
}

export function killTree(pid: number | undefined, sync = false): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      const args = ["/pid", String(pid), "/T", "/F"];
      const opts = { stdio: "ignore", windowsHide: true } as const;
      if (sync) spawnSync("taskkill", args, opts);
      else spawn("taskkill", args, opts);
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // already exited
  }
}
