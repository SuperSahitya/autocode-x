import { z } from "zod";
import { runProcess } from "../util/process.js";
import { stripAnsi, truncateMiddle } from "../util/text.js";
import { shellArgs } from "./shell.js";
import { defineTool } from "./types.js";

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

export const bashTool = defineTool({
  name: "bash",
  kind: "exec",
  description:
    "Run a shell command in the working directory and return its combined stdout/stderr and exit code. " +
    "stdin is closed, so interactive prompts fail: always pass non-interactive flags (e.g. --yes, -y, --template). " +
    "Do not start long-running servers or watchers here; they block until the timeout. " +
    `Default timeout ${DEFAULT_TIMEOUT / 1000}s, max ${MAX_TIMEOUT / 1000}s. ` +
    "Prefer read_file/grep/glob over cat/grep/find for reading and searching.",
  schema: z.object({
    command: z.string().describe("The command to run"),
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT).optional(),
  }),
  summarize: (i) => i.command,
  permissionKey: (i) => commandPermissionKey(i.command),
  async run({ command, timeout_ms = DEFAULT_TIMEOUT }, ctx) {
    const res = await runProcess(ctx.shell.path, shellArgs(ctx.shell, command), {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: timeout_ms,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      },
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
