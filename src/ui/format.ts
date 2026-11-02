import pc from "picocolors";
import { TRIMMED_MARKER } from "../agent/context.js";
import type { ToolOutput } from "../tools/types.js";
import type { ToolCallPart, Usage } from "../types.js";

const MAX_DIFF_LINES = 40;
const MAX_OUTPUT_PREVIEW = 6;
const INDENT = "    ";

export const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s*\n\s*/g, " ⏎ ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function formatToolHeader(call: ToolCallPart, summary: string, bullet = pc.cyan("●")): string {
  return `${bullet} ${pc.bold(call.name)}${summary ? pc.dim(`(${oneLine(summary, 100)})`) : ""}`;
}

export function formatUsage(usage: Usage): string {
  const cached = usage.cacheReadTokens ? `, ${formatTokens(usage.cacheReadTokens)} cached` : "";
  return pc.dim(`↑ ${formatTokens(usage.inputTokens)} ↓ ${formatTokens(usage.outputTokens)} tokens${cached}`);
}

/** Last lines of a running command's output, for the live view. */
export function formatLiveOutput(output: string, lines = 8): string {
  const tail = output.replace(/\r\n/g, "\n").trimEnd().split("\n").slice(-lines);
  return tail.map((l) => INDENT + pc.dim(oneLine(l.replace(/.*\r/, ""), 160))).join("\n");
}

export function formatToolResult(call: ToolCallPart, r: ToolOutput): string {
  const gutter = pc.dim("  ⎿ ");
  if (r.isError) {
    const lines = r.output.trim().split("\n");
    return gutter + pc.red(lines.slice(0, MAX_OUTPUT_PREVIEW).join(`\n${INDENT}`)) + more(lines.length - MAX_OUTPUT_PREVIEW);
  }
  if (r.display) {
    if (!r.display.includes("\n@@")) return gutter + pc.dim(r.display);
    return colorDiff(r.display).map((l) => INDENT + l).join("\n");
  }
  if (r.output.startsWith(TRIMMED_MARKER)) return gutter + pc.dim("Output trimmed");
  const lines = r.output.trimEnd().split("\n");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  switch (call.name) {
    case "read_file":
      return gutter + pc.dim(`Read ${plural(lines.filter((l) => /^\s*\d+\t/.test(l)).length, "line")}`);
    case "glob":
    case "grep":
    case "list_dir":
      return gutter + pc.dim(r.output.startsWith("No ") ? r.output : plural(lines.length, "result"));
    case "web_search": {
      const count = lines.filter((l) => /^\d+\. /.test(l)).length;
      return gutter + pc.dim(count ? plural(count, "result") : r.output);
    }
    case "web_fetch": {
      const title = lines[0]?.startsWith("# ") ? lines[0].slice(2) : "";
      return gutter + pc.dim(`${oneLine(title, 80)}${title ? " · " : ""}${(r.output.length / 1000).toFixed(1)}k chars`);
    }
    default: {
      const tail = lines.slice(-MAX_OUTPUT_PREVIEW);
      return gutter + pc.dim(tail.map((l) => oneLine(l, 160)).join(`\n${INDENT}`));
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

const more = (n: number) => (n > 0 ? pc.dim(`\n${INDENT}... ${n} more lines`) : "");
