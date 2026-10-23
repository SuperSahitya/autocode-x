import { rgPath } from "@vscode/ripgrep";
import { relative } from "node:path";
import { z } from "zod";
import { runProcess } from "../util/process.js";
import { truncateMiddle } from "../util/text.js";
import { resolvePath } from "./fs.js";
import { ToolError, defineTool, type ToolContext } from "./types.js";

const MAX_GLOB_RESULTS = 200;
const MAX_GREP_CHARS = 20_000;

const BASE_ARGS = ["--hidden", "--glob", "!.git", "--no-messages"];

async function rg(args: string[], ctx: ToolContext, cwd: string): Promise<string> {
  const res = await runProcess(rgPath, args, { cwd, signal: ctx.signal, timeoutMs: 60_000 });
  // exit 1 = no matches
  if (res.exitCode === 1) return "";
  if (res.exitCode !== 0 && !res.output) throw new ToolError(`ripgrep failed (exit ${res.exitCode})`);
  return res.output;
}

export const globTool = defineTool({
  name: "glob",
  kind: "read",
  description:
    `Find files by glob pattern (e.g. "**/*.tsx", "src/**/test_*.py"). Respects .gitignore. ` +
    `Returns paths sorted by most recently modified, up to ${MAX_GLOB_RESULTS}.`,
  schema: z.object({
    pattern: z.string().describe("Glob pattern"),
    path: z.string().optional().describe("Directory to search in, defaults to the working directory"),
  }),
  summarize: (i) => i.pattern + (i.path ? ` in ${i.path}` : ""),
  async run({ pattern, path = "." }, ctx) {
    const dir = resolvePath(ctx, path);
    const out = await rg([...BASE_ARGS, "--files", "--sortr", "modified", "--glob", pattern], ctx, dir);
    const files = out.split(/\r?\n/).filter(Boolean);
    if (!files.length) return "No files found.";
    const prefix = relative(ctx.cwd, dir);
    const shown = files.slice(0, MAX_GLOB_RESULTS).map((f) => (prefix ? `${prefix}/${f}` : f).replaceAll("\\", "/"));
    return shown.join("\n") + (files.length > MAX_GLOB_RESULTS ? `\n... ${files.length - MAX_GLOB_RESULTS} more; narrow the pattern.` : "");
  },
});

export const grepTool = defineTool({
  name: "grep",
  kind: "read",
  description:
    "Search file contents with a regular expression (ripgrep syntax). Respects .gitignore. " +
    'output_mode: "files" (default, matching paths), "content" (matching lines with line numbers), or "count".',
  schema: z.object({
    pattern: z.string().describe("Regular expression"),
    path: z.string().optional().describe("File or directory to search, defaults to the working directory"),
    glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts"'),
    output_mode: z.enum(["files", "content", "count"]).optional(),
    ignore_case: z.boolean().optional(),
    context: z.number().int().min(0).max(10).optional().describe("Lines of context around matches (content mode)"),
  }),
  summarize: (i) => `/${i.pattern}/` + (i.glob ? ` ${i.glob}` : "") + (i.path ? ` in ${i.path}` : ""),
  async run({ pattern, path, glob, output_mode = "files", ignore_case, context }, ctx) {
    const args = [...BASE_ARGS, "--max-columns", "300", "--max-columns-preview"];
    if (ignore_case) args.push("-i");
    if (glob) args.push("--glob", glob);
    if (output_mode === "files") args.push("--files-with-matches", "--sortr", "modified");
    else if (output_mode === "count") args.push("--count");
    else {
      args.push("--line-number", "--no-heading", "--with-filename");
      if (context) args.push("-C", String(context));
    }
    args.push("-e", pattern, path ? resolvePath(ctx, path) : ".");
    let out = (await rg(args, ctx, ctx.cwd)).trim();
    // only in files mode: content lines can contain real backslashes
    if (output_mode === "files") out = out.replaceAll("\\", "/");
    return out ? truncateMiddle(out, MAX_GREP_CHARS) : "No matches.";
  },
});
