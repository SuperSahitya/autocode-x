import { z } from "zod";
import { runProcess } from "../util/process.js";
import { stripAnsi, truncateMiddle } from "../util/text.js";
import { shellArgs } from "./shell.js";
import type { BackgroundProcess } from "./processes.js";
import { ToolError, defineTool } from "./types.js";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

// "always allow" is scoped to the subcommand for these: git status != git push
const SUBCOMMAND_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "docker", "pip", "uv", "dotnet", "gh"]);

export function commandPermissionKey(command: string): string | undefined {
  if (/[;&|`$()<>\n]/.test(command)) return undefined;
  const [first, second] = command.trim().split(/\s+/);
  if (!first) return undefined;
  if (second && SUBCOMMAND_TOOLS.has(first) && /^[a-z][\w:-]*$/.test(second)) return `bash:${first} ${second}`;
  return `bash:${first}`;
}

const commandEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
});

function processStatus(proc: BackgroundProcess): string {
  return proc.running ? `[${proc.id} running]` : `[${proc.id} exited with code ${proc.exitCode}]`;
}

export const bashTool = defineTool({
  name: "bash",
  kind: "exec",
  description:
    "Run a shell command in the working directory and return its combined stdout/stderr and exit code. " +
    "stdin is closed, so interactive prompts fail: always pass non-interactive flags (e.g. --yes, -y, --template). " +
    "For dev servers, watchers and anything else that doesn't exit, set run_in_background and use bash_output " +
    "to check on it. " +
    `Default timeout ${DEFAULT_TIMEOUT / 1000}s, max ${MAX_TIMEOUT / 1000}s. ` +
    "Prefer read_file/grep/glob over cat/grep/find for reading and searching.",
  schema: z.object({
    command: z.string().describe("The command to run"),
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT).optional(),
    run_in_background: z.boolean().optional().describe("Start the command and return immediately with a process id"),
  }),
  summarize: (i) => i.command + (i.run_in_background ? " &" : ""),
  permissionKey: (i) => commandPermissionKey(i.command),
  async run({ command, timeout_ms = DEFAULT_TIMEOUT, run_in_background }, ctx) {
    if (run_in_background) {
      const proc = ctx.processes.start(command, ctx.shell, ctx.cwd, commandEnv());
      // short grace period so immediate failures (bad command, port in use) show up now
      await ctx.processes.waitForOutput(proc, 3000, ctx.signal);
      const out = truncateMiddle(ctx.processes.readNew(proc).trimEnd(), MAX_OUTPUT_CHARS);
      return {
        output: `Started ${proc.id}. Use bash_output to read more output.\n${out}\n${processStatus(proc)}`,
        isError: !proc.running && proc.exitCode !== 0,
      };
    }
    const res = await runProcess(ctx.shell.path, shellArgs(ctx.shell, command), {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: timeout_ms,
      env: commandEnv(),
    });
    let output = truncateMiddle(stripAnsi(res.output).trimEnd(), MAX_OUTPUT_CHARS);
    if (res.timedOut) output += `\n[Timed out after ${timeout_ms / 1000}s and was killed]`;
    if (res.aborted) output += "\n[Interrupted by user]";
    const status = res.exitCode === null ? "" : `\n[exit code ${res.exitCode}]`;
    return {
      output: (output || "(no output)") + status,
      isError: res.timedOut || res.aborted || (res.exitCode ?? 1) !== 0,
    };
  },
});

export const bashOutputTool = defineTool({
  name: "bash_output",
  kind: "read",
  description:
    "Read new output from a background process started with run_in_background. " +
    "wait_ms waits up to that long for new output, e.g. for a server to finish starting. Without id, lists processes.",
  schema: z.object({
    id: z.string().optional().describe("Process id, e.g. bg1"),
    wait_ms: z.number().int().min(0).max(60_000).optional(),
  }),
  summarize: (i) => i.id ?? "list",
  async run({ id, wait_ms = 0 }, ctx) {
    if (!id) {
      const procs = ctx.processes.list();
      return procs.length ? procs.map((p) => `${processStatus(p)} ${p.command}`).join("\n") : "No background processes.";
    }
    const proc = ctx.processes.get(id);
    if (!proc) throw new ToolError(`No background process ${id}.`);
    if (wait_ms) await ctx.processes.waitForOutput(proc, wait_ms, ctx.signal);
    const out = truncateMiddle(ctx.processes.readNew(proc).trimEnd(), MAX_OUTPUT_CHARS);
    return `${out || "(no new output)"}\n${processStatus(proc)}`;
  },
});

export const killProcessTool = defineTool({
  name: "kill_process",
  kind: "exec",
  description: "Stop a background process started with run_in_background.",
  schema: z.object({ id: z.string().describe("Process id, e.g. bg1") }),
  summarize: (i) => i.id,
  async run({ id }, ctx) {
    const proc = ctx.processes.get(id);
    if (!proc) throw new ToolError(`No background process ${id}.`);
    if (!proc.running) return `${id} had already exited with code ${proc.exitCode}.`;
    ctx.processes.kill(proc);
    return `Killed ${id}.`;
  },
});
