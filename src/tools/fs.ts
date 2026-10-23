import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { countOccurrences, numberLines } from "../util/text.js";
import { ToolError, defineTool, type ToolContext } from "./types.js";

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;

export const resolvePath = (ctx: ToolContext, p: string) => (isAbsolute(p) ? resolve(p) : resolve(ctx.cwd, p));
export const displayPath = (ctx: ToolContext, abs: string) => {
  const rel = relative(ctx.cwd, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : abs;
};

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function assertFresh(ctx: ToolContext, abs: string): Promise<boolean> {
  const st = await statOrNull(abs);
  if (!st) return false;
  const seen = ctx.fileState.get(abs);
  if (seen === undefined) throw new ToolError(`${displayPath(ctx, abs)} exists but hasn't been read yet. Read it first.`);
  if (st.mtimeMs !== seen) {
    throw new ToolError(`${displayPath(ctx, abs)} was modified since it was last read. Read it again before changing it.`);
  }
  return true;
}

async function writeTracked(ctx: ToolContext, abs: string, content: string) {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  ctx.fileState.set(abs, (await stat(abs)).mtimeMs);
}

function makeDiff(ctx: ToolContext, abs: string, before: string, after: string): string {
  const name = displayPath(ctx, abs);
  return createTwoFilesPatch(name, name, before, after, undefined, undefined, { context: 3 })
    .split("\n")
    .slice(2) // drop the "Index:/===" header lines
    .join("\n");
}

export const readFileTool = defineTool({
  name: "read_file",
  kind: "read",
  description:
    `Read a text file. Returns lines prefixed with line numbers (cat -n style). ` +
    `Reads up to ${MAX_READ_LINES} lines by default; use offset/limit for large files. ` +
    `You must read a file before editing or overwriting it.`,
  schema: z.object({
    path: z.string().describe("File path, absolute or relative to the working directory"),
    offset: z.number().int().min(1).optional().describe("1-based line to start from"),
    limit: z.number().int().min(1).optional().describe("Number of lines to read"),
  }),
  summarize: (i) => i.path + (i.offset ? `:${i.offset}` : ""),
  async run({ path, offset = 1, limit = MAX_READ_LINES }, ctx) {
    const abs = resolvePath(ctx, path);
    const st = await statOrNull(abs);
    if (!st) throw new ToolError(`File not found: ${path}`);
    if (st.isDirectory()) throw new ToolError(`${path} is a directory. Use list_dir instead.`);

    const buf = await readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new ToolError(`${path} appears to be a binary file (${st.size} bytes).`);
    ctx.fileState.set(abs, st.mtimeMs);

    const all = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
    if (all.at(-1) === "") all.pop();
    if (all.length === 0) return `${path} is empty.`;
    const slice = all
      .slice(offset - 1, offset - 1 + limit)
      .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}... [line truncated]` : l));
    if (slice.length === 0) throw new ToolError(`offset ${offset} is past the end of the file (${all.length} lines).`);

    let out = numberLines(slice, offset);
    const end = offset - 1 + slice.length;
    if (end < all.length) out += `\n\n[Showing lines ${offset}-${end} of ${all.length}. Use offset to read more.]`;
    return out;
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  kind: "write",
  description:
    "Create a new file or completely overwrite an existing one. Parent directories are created as needed. " +
    "For changes to an existing file prefer edit_file. Overwriting requires reading the file first.",
  schema: z.object({
    path: z.string().describe("File path, absolute or relative to the working directory"),
    content: z.string().describe("The full file content"),
  }),
  summarize: (i) => i.path,
  async run({ path, content }, ctx) {
    const abs = resolvePath(ctx, path);
    const existed = await assertFresh(ctx, abs);
    const before = existed ? await readFile(abs, "utf8") : "";
    await writeTracked(ctx, abs, content);
    const lines = content.split("\n").length;
    const name = displayPath(ctx, abs);
    return existed
      ? { output: `Overwrote ${name} (${lines} lines).`, display: makeDiff(ctx, abs, before, content) }
      : { output: `Created ${name} (${lines} lines).`, display: `Created ${name} (${lines} lines)` };
  },
});

export const editFileTool = defineTool({
  name: "edit_file",
  kind: "write",
  description:
    "Edit a file by exact string replacement. old_string must match the file exactly (including whitespace and " +
    "indentation, without the line-number prefix from read_file) and must be unique unless replace_all is true; " +
    "include enough surrounding lines to make it unique. Read the file first.",
  schema: z.object({
    path: z.string().describe("File path, absolute or relative to the working directory"),
    old_string: z.string().describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
  }),
  summarize: (i) => i.path,
  async run({ path, old_string, new_string, replace_all }, ctx) {
    if (old_string === "") throw new ToolError("old_string is empty. Use write_file to create files.");
    if (old_string === new_string) throw new ToolError("old_string and new_string are identical.");
    const abs = resolvePath(ctx, path);
    if (!(await assertFresh(ctx, abs))) throw new ToolError(`File not found: ${path}`);

    const raw = await readFile(abs, "utf8");
    // match on LF, write back with the file's own line endings
    const crlf = raw.includes("\r\n");
    const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
    const oldS = old_string.replace(/\r\n/g, "\n");
    const newS = new_string.replace(/\r\n/g, "\n");

    const count = countOccurrences(text, oldS);
    if (count === 0) {
      throw new ToolError(`old_string not found in ${path}. Re-read the file and copy the text exactly.`);
    }
    if (count > 1 && !replace_all) {
      throw new ToolError(`old_string appears ${count} times in ${path}. Add surrounding context to make it unique, or set replace_all.`);
    }
    const updated = replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    await writeTracked(ctx, abs, crlf ? updated.replace(/\n/g, "\r\n") : updated);

    // return the edited region so the model doesn't need to re-read
    const startLine = text.slice(0, text.indexOf(oldS)).split("\n").length;
    const lines = updated.split("\n");
    const from = Math.max(1, startLine - 3);
    const to = Math.min(lines.length, startLine + newS.split("\n").length + 2);
    const snippet = numberLines(lines.slice(from - 1, to), from);
    const name = displayPath(ctx, abs);
    return {
      output: `Edited ${name}${count > 1 ? ` (${count} replacements)` : ""}. Snippet of the result:\n${snippet}`,
      display: makeDiff(ctx, abs, text, updated),
    };
  },
});

export const listDirTool = defineTool({
  name: "list_dir",
  kind: "read",
  description: "List a directory's entries (directories end with /). Use glob to find files recursively.",
  schema: z.object({
    path: z.string().optional().describe("Directory, defaults to the working directory"),
  }),
  summarize: (i) => i.path ?? ".",
  async run({ path = "." }, ctx) {
    const abs = resolvePath(ctx, path);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      throw new ToolError(`Not a readable directory: ${path}`);
    }
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
    if (!names.length) return `${path} is empty.`;
    const MAX = 500;
    return names.slice(0, MAX).join("\n") + (names.length > MAX ? `\n... and ${names.length - MAX} more` : "");
  },
});
