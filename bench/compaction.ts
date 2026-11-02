// How much of a long session survives compaction, against simply dropping the oldest messages to reach
// the same size. Spends real requests: 4 per session, and answers are saved so a rerun doesn't spend them again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.js";
import { estimateMessages, findSplit, trimToolOutputs } from "../src/agent/context.js";
import { Permissions } from "../src/agent/permissions.js";
import { createProvider, loadConfig, resolveModelSpec } from "../src/config.js";
import { ToolRegistry } from "../src/tools/index.js";
import { detectShell } from "../src/tools/shell.js";
import type { Message, Provider } from "../src/types.js";
import { SCENARIOS, buildMessages, type Fact, type Scenario } from "./compaction-sessions.js";
import { BENCH_DIR, bootstrapCI, mean, pct, saveResults, table } from "./lib.js";

// the built-in limit for local models, which is where a small context matters most
const CONTEXT_LIMIT = 32_000;
const CONDITIONS = ["full", "compacted", "dropOldest"] as const;
type Condition = (typeof CONDITIONS)[number];

const ANSWER_SYSTEM = `You are a coding agent picking up a session. Answer from this conversation only. Reply with only a JSON array of strings, one answer per question, in order. If the conversation doesn't contain an answer, write "unknown" for it. Don't guess.`;

const RAW_PATH = join(BENCH_DIR, "results", "compaction-raw.json");
type Raw = Record<string, { text: string; inputTokens?: number; requests: number; kept?: number }>;
const raw: Raw = existsSync(RAW_PATH) ? JSON.parse(readFileSync(RAW_PATH, "utf8")) : {};
const remember = (key: string, value: Raw[string]) => {
  raw[key] = value;
  mkdirSync(join(BENCH_DIR, "results"), { recursive: true });
  writeFileSync(RAW_PATH, `${JSON.stringify(raw, null, 2)}\n`);
};

const config = loadConfig();
const chosen = resolveModelSpec(config, process.argv[2]);
const provider: Provider = createProvider({ ...chosen.profile, requestsPerMinute: chosen.profile.requestsPerMinute ?? 6 });

function newAgent(system: string, messages: Message[], contextLimit: number) {
  const agent = new Agent({
    provider,
    tools: new ToolRegistry([]),
    permissions: new Permissions("auto", async () => "allow"),
    system,
    cwd: process.cwd(),
    shell: detectShell(),
    contextLimit,
    maxSteps: 1,
  });
  agent.load({ messages, usage: agent.totalUsage, checkpoints: [] });
  return agent;
}

async function ask(key: string, messages: Message[], facts: Fact[]) {
  if (raw[key]) return raw[key];
  const agent = newAgent(ANSWER_SYSTEM, messages, 10_000_000);
  const inputTokens: number[] = [];
  await agent.run(facts.map((f, i) => `${i + 1}. ${f.question}`).join("\n"), { onStepEnd: (u) => inputTokens.push(u.inputTokens + (u.cacheReadTokens ?? 0)) });
  const last = agent.messages.at(-1);
  const text = last?.role === "assistant" ? last.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : "";
  const entry = { text, inputTokens: inputTokens[0], requests: agent.totalUsage.requests ?? 0 };
  remember(key, entry);
  return entry;
}

function parseAnswers(text: string, count: number): string[] {
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return Array.from({ length: count }, (_, i) => String(parsed[i] ?? "unknown"));
  } catch {
    // scored as unknown below
  }
  return Array.from({ length: count }, () => "unknown");
}

function score(fact: Fact, answer: string): "correct" | "unknown" | "wrong" {
  if (new RegExp(fact.answer, "i").test(answer)) return "correct";
  return /^\s*unknown/i.test(answer) ? "unknown" : "wrong";
}

async function runScenario(scenario: Scenario) {
  const original = buildMessages(scenario);
  const rawTokens = estimateMessages(original);

  // trim then summarize, as the agent does when a session crosses its limit
  const trimmed = structuredClone(original);
  trimToolOutputs(trimmed);
  const trimmedTokens = estimateMessages(trimmed);
  // the agent only summarizes past 80% of the limit, so a session under it would test a path it never takes
  if (trimmedTokens < CONTEXT_LIMIT * 0.8) throw new Error(`${scenario.name} is too small after trimming: ${trimmedTokens}`);

  const compactKey = `${scenario.name}/summary`;
  let compacted: Message[];
  if (raw[compactKey]) {
    const { text, kept } = raw[compactKey];
    compacted = [{ role: "user", content: [{ type: "text", text }] }, ...trimmed.slice(trimmed.length - kept!)];
  } else {
    const agent = newAgent("bench", structuredClone(trimmed), CONTEXT_LIMIT);
    const done = await agent.compact({ onNotice: (m) => console.error(`  ${m}`) }, undefined, true);
    if (!done) throw new Error(`${scenario.name} wasn't compacted`);
    compacted = agent.messages;
    const first = compacted[0]!.content[0]!;
    if (first.type !== "text") throw new Error("expected a summary first");
    remember(compactKey, { text: first.text, requests: agent.totalUsage.requests ?? 0, kept: compacted.length - 1 });
  }
  const compactedTokens = estimateMessages(compacted);

  // the same size of context, spent on the newest messages alone
  const split = findSplit(original, compactedTokens) ?? original.length - 1;
  const dropped: Message[] = [{ role: "user", content: [{ type: "text", text: "[Earlier conversation dropped to save context]" }] }, ...structuredClone(original.slice(split))];

  const contexts: Record<Condition, Message[]> = { full: structuredClone(original), compacted: structuredClone(compacted), dropOldest: dropped };
  const conditions = {} as Record<Condition, { tokens: number; inputTokens?: number; scores: { kind: string; result: string; answer: string }[] }>;
  for (const c of CONDITIONS) {
    console.error(`  ${c}...`);
    const reply = await ask(`${scenario.name}/${c}`, contexts[c], scenario.facts);
    const answers = parseAnswers(reply.text, scenario.facts.length);
    conditions[c] = {
      tokens: estimateMessages(contexts[c]),
      inputTokens: reply.inputTokens,
      scores: scenario.facts.map((f, i) => ({ kind: f.kind, result: score(f, answers[i]!), answer: answers[i]! })),
    };
  }
  return { name: scenario.name, rawTokens, trimmedTokens, compactedTokens, conditions };
}

const sessions: Awaited<ReturnType<typeof runScenario>>[] = [];
for (const scenario of SCENARIOS) {
  console.error(scenario.name);
  sessions.push(await runScenario(scenario));
}

const scoresFor = (c: Condition) => sessions.flatMap((s) => s.conditions[c].scores);
const rate = (scores: { result: string }[], result: string) => mean(scores.map((s) => Number(s.result === result)));
const summary = Object.fromEntries(
  CONDITIONS.map((c) => {
    const scores = scoresFor(c);
    const [low, high] = bootstrapCI(scores.map((s) => Number(s.result === "correct")));
    return [
      c,
      {
        correct: rate(scores, "correct"),
        correctLow: low,
        correctHigh: high,
        unknown: rate(scores, "unknown"),
        wrong: rate(scores, "wrong"),
        tokens: mean(sessions.map((s) => s.conditions[c].tokens)),
        apiInputTokens: mean(sessions.map((s) => s.conditions[c].inputTokens ?? 0)),
      },
    ];
  }),
) as Record<Condition, { correct: number; correctLow: number; correctHigh: number; unknown: number; wrong: number; tokens: number; apiInputTokens: number }>;
const kinds = [...new Set(scoresFor("full").map((s) => s.kind))];
const byKind = Object.fromEntries(kinds.map((k) => [k, Object.fromEntries(CONDITIONS.map((c) => [c, rate(scoresFor(c).filter((s) => s.kind === k), "correct")]))])) as Record<string, Record<Condition, number>>;

console.log(`${sessions.length} sessions, ${scoresFor("full").length} facts, model ${chosen.profile.model}\n`);
console.log(
  table([
    ["context", "tokens (est)", "tokens (API)", "correct", "95% CI", "said unknown", "wrong"],
    ...CONDITIONS.map((c) => {
      const s = summary[c];
      return [c, Math.round(s.tokens), Math.round(s.apiInputTokens), pct(s.correct), `${pct(s.correctLow)}-${pct(s.correctHigh)}`, pct(s.unknown), pct(s.wrong)];
    }),
  ]),
);
console.log(`\n${table([["fact kind", ...CONDITIONS], ...kinds.map((k) => [k, ...CONDITIONS.map((c) => pct(byKind[k]![c]))])])}`);
console.log(`\n${table([["session", "raw", "after trim", "after summary"], ...sessions.map((s) => [s.name, s.rawTokens, s.trimmedTokens, s.compactedTokens])])}`);
const spent = Object.values(raw).reduce((n, r) => n + r.requests, 0);
console.log(`\nModel requests spent: ${spent}`);

saveResults("compaction", {
  model: chosen.profile.model,
  contextLimit: CONTEXT_LIMIT,
  requestsSpent: spent,
  summary,
  byKind,
  sessions: sessions.map((s) => ({
    name: s.name,
    rawTokens: s.rawTokens,
    trimmedTokens: s.trimmedTokens,
    compactedTokens: s.compactedTokens,
    correct: Object.fromEntries(CONDITIONS.map((c) => [c, rate(s.conditions[c].scores, "correct")])),
  })),
});
process.exit(0);
