import { ProviderError } from "../providers/sse.js";
import type { Message, ToolCallPart, ToolResultPart } from "../types.js";
import { truncateMiddle } from "../util/text.js";

export const DEFAULT_CONTEXT_LIMIT = 100_000;
export const COMPACT_MARKER = "[Earlier conversation compacted to save context]";
export const TRIMMED_MARKER = "[Old output trimmed to save context";

const KEEP_RECENT_RESULTS = 6;
const MIN_TRIM_CHARS = 800;
const KEPT_CHARS = 600;
const MAX_TRANSCRIPT_CHARS = 80_000;
const MAX_REQUEST_CHARS = 500;
const MAX_REQUESTS = 12;

// these can simply be run again, so nothing is lost by dropping their output
const REPEATABLE = new Set(["read_file", "list_dir", "glob", "grep", "web_fetch", "web_search"]);

export const SUMMARY_SYSTEM = `You compact the conversation of a coding agent so it can keep working with less context. The agent will see only your summary and the most recent messages.

Write these sections, skipping any that are empty:
- Goal: what the user wants overall
- Done: what has been changed and why
- Decisions: choices made and constraints the user gave
- Current state: what was last being worked on, what's failing, exact error messages
- Next: what remains

Keep file paths, function names and commands exact. Leave out file contents and anything that can be found again by reading the code. Under 400 words, no preamble.`;

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function estimateMessages(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === "text") chars += p.text.length;
      else if (p.type === "tool_call") chars += p.name.length + JSON.stringify(p.input ?? {}).length;
      else chars += p.content.length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Replace old tool output with a short stub. Costs no model request, so it runs before any summary.
 * Mutates in place and returns the characters saved.
 */
export function trimToolOutputs(messages: Message[]): number {
  const calls = new Map<string, ToolCallPart>();
  const results: ToolResultPart[] = [];
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === "tool_call") calls.set(p.id, p);
      else if (p.type === "tool_result") results.push(p);
    }
  }

  let saved = 0;
  const seen = new Set<string>();
  results.forEach((_, i) => {
    const r = results[results.length - 1 - i]!;
    const call = calls.get(r.id);
    const repeatable = call !== undefined && REPEATABLE.has(call.name);
    const key = repeatable ? `${call.name}:${JSON.stringify(call.input)}` : undefined;
    // a later identical call made this one out of date, however recent it is
    const superseded = key !== undefined && seen.has(key);
    if (key) seen.add(key);

    if (r.content.startsWith(TRIMMED_MARKER)) return;
    if (!superseded && (i < KEEP_RECENT_RESULTS || r.content.length < MIN_TRIM_CHARS)) return;
    const next = repeatable
      ? `${TRIMMED_MARKER}: ${call.name} returned ${r.content.length} chars. Run it again if you still need them.]`
      : `${TRIMMED_MARKER}]\n${truncateMiddle(r.content, KEPT_CHARS)}`;
    if (next.length >= r.content.length) return;
    saved += r.content.length - next.length;
    r.content = next;
  });
  return saved;
}

/**
 * Where to cut for a summary. The kept part starts at an assistant message so every tool result
 * stays with its call, and because it follows the summary, a user message, roles keep alternating.
 */
export function findSplit(messages: Message[], keepTokens: number): number | undefined {
  let best: number | undefined;
  let tail = 0;
  // stops at 2 so there's always something before the cut to summarize
  for (let i = messages.length - 1; i >= 2; i--) {
    tail += estimateMessages([messages[i]!]);
    if (messages[i]!.role !== "assistant") continue;
    if (best !== undefined && tail > keepTokens) break;
    best = i;
  }
  return best;
}

export function renderTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === "text") lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${p.text}`);
      else if (p.type === "tool_call") lines.push(`Tool call: ${p.name}(${JSON.stringify(p.input ?? {}).slice(0, 300)})`);
      else lines.push(`Tool result${p.isError ? " (error)" : ""}: ${truncateMiddle(p.content, 1500)}`);
    }
  }
  return truncateMiddle(lines.join("\n"), MAX_TRANSCRIPT_CHARS);
}

function sectionItems(text: string, heading: string): string[] {
  const start = text.indexOf(`## ${heading}\n`);
  if (start === -1) return [];
  const body = text.slice(start + heading.length + 4).split("\n## ")[0]!;
  return body.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
}

/**
 * The summary message. Requests and changed files are collected from the messages rather than
 * left to the model, so they survive a bad summary, a failed one, or several rounds of compaction.
 */
export function buildSummaryMessage(head: Message[], summary: string): string {
  const requests: string[] = [];
  const files = new Set<string>();
  for (const m of head) {
    for (const p of m.content) {
      if (p.type === "text" && m.role === "user") {
        if (p.text.startsWith(COMPACT_MARKER)) {
          requests.push(...sectionItems(p.text, "User requests"));
          for (const f of sectionItems(p.text, "Files changed")) files.add(f);
        } else if (!p.text.startsWith("[")) {
          requests.push(p.text.replace(/\s+/g, " ").slice(0, MAX_REQUEST_CHARS));
        }
      } else if (p.type === "tool_call" && (p.name === "write_file" || p.name === "edit_file")) {
        const path = (p.input as { path?: unknown } | undefined)?.path;
        if (typeof path === "string") files.add(path);
      }
    }
  }
  const sections = [COMPACT_MARKER];
  if (requests.length) sections.push(`## User requests\n${requests.slice(-MAX_REQUESTS).map((r) => `- ${r}`).join("\n")}`);
  if (summary) sections.push(`## Summary\n${summary}`);
  if (files.size) sections.push(`## Files changed\n${[...files].map((f) => `- ${f}`).join("\n")}`);
  sections.push("Read a file again before relying on what it contained.");
  return sections.join("\n\n");
}

export function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof ProviderError) || (err.status !== 400 && err.status !== 413)) return false;
  return /context.{0,20}(length|window|limit)|too (long|large)|exceeds?.{0,40}tokens?|tokens?.{0,40}exceed/i.test(err.message);
}
