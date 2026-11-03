// How well memory finds the right note or conversation, and whether that gets the right answer in a new session.
//   npm run bench:memory -- --check   checks the questions and spends nothing
//   npm run bench:memory              retrieval; a few embedding requests, saved so a rerun spends none
//   npm run bench:memory -- --tune    compares fusion settings on the even-numbered questions only
//   npm run bench:memory -- --scale   search time as the store grows, with made-up vectors
//   npm run bench:memory -- --e2e     real model in new sessions, 70 requests at most (--cap); answers are saved
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { createProvider, loadConfig, resolveModelSpec } from "../src/config.js";
import { EMBEDDING_DIMENSIONS, GeminiEmbedder, type EmbedInput, type Embedder } from "../src/memory/embed.js";
import { Memory, fuse } from "../src/memory/store.js";
import { memorySection, memoryTools } from "../src/memory/tools.js";
import type { Session } from "../src/session/store.js";
import { DEFAULT_TOOLS, ToolRegistry } from "../src/tools/index.js";
import { detectShell } from "../src/tools/shell.js";
import type { Provider } from "../src/types.js";
import { BudgetExhausted, CappedProvider, BENCH_DIR, bootstrapCI, hash, mean, pct, percentile, saveResults, seeded, table } from "./lib.js";
import { FACTS, LOOKALIKES, NEAR_MISSES, ROUND_TRIPS, UNANSWERABLE, type Fact, type QueryClass } from "./memory-corpus.js";

const TOP_K = 5;
const COMMITS_PER_REPO = 50;
const E2E_CAP = 70;
// with nothing to find, the model searches until the step limit, so more of these only spend quota
const OFF_RUNS = 7;
const E2E_MAX_STEPS = 6;
const CWD = "/bench-project";
const REPOS_DIR = join(BENCH_DIR, ".repos");
const EMBEDDINGS_PATH = join(BENCH_DIR, "results", "memory-embeddings.json");
const ANSWERS_PATH = join(BENCH_DIR, "results", "memory-answers.json");
const REFUSAL = /\b(don't|do not|couldn't|could not|can't|cannot|unable|no record|no information|not find|not found|nothing|isn't|is not|not sure|haven't)\b/i;

const save = (path: string, data: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
};
const tempFile = () => join(mkdtempSync(join(tmpdir(), "autocode-memory-")), "memory.db");
const remove = (path: string) => rmSync(dirname(path), { recursive: true, force: true, maxRetries: 3 });

/** Real commit messages from the repo map's repositories, as many unrelated things a project might have said. */
function commitMessages(): string[] {
  if (!existsSync(REPOS_DIR)) throw new Error("No repositories to read. Run npm run bench:repomap first, which clones them.");
  const out: string[] = [];
  for (const repo of readdirSync(REPOS_DIR).sort()) {
    const log = execFileSync("git", ["-C", join(REPOS_DIR, repo), "log", "--no-merges", `-n${COMMITS_PER_REPO * 3}`, "--format=%B%x00"], { encoding: "utf8", maxBuffer: 1 << 28 });
    const messages = log.split("\0").map((m) => m.trim().slice(0, 600)).filter((m) => m.length >= 40);
    out.push(...messages.slice(0, COMMITS_PER_REPO));
  }
  return [...new Set(out)];
}

const conversation = (id: string, text: string): Session => ({
  version: 1,
  id,
  cwd: CWD,
  title: text.split("\n")[0]!.replace(/^user: /, "").slice(0, 80),
  profile: "bench",
  model: "bench",
  createdAt: 1,
  updatedAt: 1,
  messages: text.split("\n").map((line) => {
    const [role, ...rest] = line.split(": ");
    return { role: role as "user" | "assistant", content: [{ type: "text" as const, text: rest.join(": ") }] };
  }) as Session["messages"],
  usage: { inputTokens: 0, outputTokens: 0 },
  checkpoints: [],
});

/** Facts go in first, so the newest notes, which the prompt shows, are unrelated and search has to find them. */
function fill(memory: Memory, noise: string[]): void {
  const facts = FACTS.filter((f) => !f.text.startsWith("user: "));
  for (const fact of facts) memory.remember(fact.text);
  memory.indexSessions(FACTS.filter((f) => f.text.startsWith("user: ")).map((f) => conversation(`fact-${f.id}`, f.text)));
  for (const text of [...NEAR_MISSES, ...LOOKALIKES, ...noise]) memory.remember(text);
}

const rankOf = (memory: Memory, ids: number[], fact: Fact) => ids.findIndex((id) => memory.item(id)!.text.includes(sessionText(fact))) + 1;
const sessionText = (fact: Fact) => fact.text.split("\n").at(-1)!.replace(/^assistant: /, "");

/** Keeps vectors on disk, as the quota is limited and the same text always gets the same vector. */
class SavedEmbedder implements Embedder {
  requests = 0;
  private readonly saved: Record<string, number[]> = existsSync(EMBEDDINGS_PATH) ? JSON.parse(readFileSync(EMBEDDINGS_PATH, "utf8")) : {};

  constructor(private readonly inner: Embedder | undefined) {}

  private key = (input: EmbedInput) => `${input.kind}:${hash(JSON.stringify(input))}:${input.text.length}`;

  async embed(inputs: EmbedInput[], signal?: AbortSignal): Promise<number[][]> {
    const missing = inputs.filter((i) => !this.saved[this.key(i)]);
    if (missing.length) {
      if (!this.inner) throw new Error("Embedding needs a Gemini API key.");
      this.requests += Math.ceil(missing.length / 100);
      const vectors = await this.inner.embed(missing, signal);
      missing.forEach((input, i) => (this.saved[this.key(input)] = vectors[i]!));
      save(EMBEDDINGS_PATH, this.saved);
    }
    return inputs.map((i) => this.saved[this.key(i)]!);
  }
}

function geminiEmbedder(): Embedder | undefined {
  const { gemini } = loadConfig().profiles;
  const apiKey = gemini?.apiKey ?? (gemini?.apiKeyEnv ? process.env[gemini.apiKeyEnv] : undefined);
  return apiKey ? new GeminiEmbedder(apiKey, gemini!.baseUrl) : undefined;
}

// a "reworded" question that keyword search can reach isn't what its label claims
function check(noise: string[]): void {
  const path = tempFile();
  const memory = new Memory({ path, cwd: CWD });
  fill(memory, noise);
  const bad = FACTS.filter((f) => f.queryClass === "reworded" && rankOf(memory, memory.keywordSearch(f.question, 10_000), f) > 0);
  const exact = FACTS.filter((f) => f.queryClass !== "reworded" && rankOf(memory, memory.keywordSearch(f.question, 10_000), f) === 0);
  memory.close();
  remove(path);
  for (const f of bad) console.log(`reworded but found by keyword: ${f.id} ${f.question}`);
  for (const f of exact) console.log(`labelled ${f.queryClass} but shares no word: ${f.id} ${f.question}`);
  console.log(`${FACTS.length} facts, ${NEAR_MISSES.length} near misses, ${LOOKALIKES.length} lookalikes, ${noise.length} commit messages`);
  if (bad.length || exact.length) process.exit(1);
  console.log("Questions match their labels.");
}

async function retrieval(noise: string[]): Promise<void> {
  const embedder = new SavedEmbedder(geminiEmbedder());
  const path = tempFile();
  const memory = new Memory({ path, cwd: CWD, embedder });
  fill(memory, noise);
  while (await memory.embedPending());
  await embedder.embed(FACTS.map((f) => ({ kind: "query", text: f.question })));

  type Mode = "keyword" | "vector" | "hybrid";
  const ranks: Record<Mode, number[]> = { keyword: [], vector: [], hybrid: [] };
  for (const fact of FACTS) {
    const [vector] = await embedder.embed([{ kind: "query", text: fact.question }]);
    ranks.keyword.push(rankOf(memory, memory.keywordSearch(fact.question, TOP_K), fact));
    ranks.vector.push(rankOf(memory, memory.vectorSearch(vector!, TOP_K), fact));
    const { items, warning } = await memory.recall(fact.question, TOP_K);
    if (warning) throw new Error(warning);
    ranks.hybrid.push(rankOf(memory, items.map((i) => i.id), fact));
  }
  memory.close();
  remove(path);

  const hit = (r: number) => Number(r > 0 && r <= TOP_K);
  const reciprocal = (r: number) => (hit(r) ? 1 / r : 0);
  const modes = Object.keys(ranks) as Mode[];
  type Group = QueryClass | "all" | "held out";
  const classes: Group[] = ["all", "held out", "exact", "partial", "reworded"];
  const inGroup = (fact: Fact, c: Group) => c === "all" || (c === "held out" ? fact.id % 2 === 1 : fact.queryClass === c);
  const of = (mode: Mode, c: Group) => ranks[mode].filter((_, i) => inGroup(FACTS[i]!, c));
  console.log(
    table([
      ["questions", "n", ...modes.map((m) => `${m} recall@${TOP_K}`), ...modes.map((m) => `${m} MRR@${TOP_K}`)],
      ...classes.map((c) => [c, of("keyword", c).length, ...modes.map((m) => pct(mean(of(m, c).map(hit)))), ...modes.map((m) => mean(of(m, c).map(reciprocal)).toFixed(3))]),
    ]),
  );
  const difference = (a: Mode, b: Mode) => {
    const diffs = ranks[a].map((r, i) => reciprocal(r) - reciprocal(ranks[b][i]!));
    const [low, high] = bootstrapCI(diffs);
    return { mean: mean(diffs), low, high };
  };
  const compare = { hybridVsKeyword: difference("hybrid", "keyword"), hybridVsVector: difference("hybrid", "vector") };
  console.log(`\nStore: ${FACTS.length + NEAR_MISSES.length + LOOKALIKES.length + noise.length} items. Embedding requests this run: ${embedder.requests}`);
  for (const [name, d] of Object.entries(compare)) console.log(`${name}, MRR difference: ${d.mean.toFixed(3)} (95% CI ${d.low.toFixed(3)} to ${d.high.toFixed(3)})`);
  saveResults("memory-retrieval", {
    store: FACTS.length + NEAR_MISSES.length + LOOKALIKES.length + noise.length,
    results: classes.map((c) => ({ questions: c, n: of("keyword", c).length, ...Object.fromEntries(modes.map((m) => [m, { recall: mean(of(m, c).map(hit)), mrr: mean(of(m, c).map(reciprocal)) }])) })),
    compare,
    ranks: FACTS.map((f, i) => ({ id: f.id, queryClass: f.queryClass, keyword: ranks.keyword[i], vector: ranks.vector[i], hybrid: ranks.hybrid[i] })),
  });
}

// the odd-numbered questions stay out of this, so the settings aren't fitted to what's reported
async function tune(noise: string[]): Promise<void> {
  const embedder = new SavedEmbedder(geminiEmbedder());
  const path = tempFile();
  const memory = new Memory({ path, cwd: CWD, embedder });
  fill(memory, noise);
  while (await memory.embedPending());
  const facts = FACTS.filter((f) => f.id % 2 === 0);
  const vectors = await embedder.embed(facts.map((f) => ({ kind: "query", text: f.question })));
  const rows: (string | number)[][] = [["candidates", "keyword weight", `recall@${TOP_K}`, "MRR", "exact MRR", "reworded MRR"]];
  for (const candidates of [5, 10, 20, 50]) {
    for (const weight of [1, 0.5, 0.25]) {
      const ranks = facts.map((f, i) => rankOf(memory, fuse([memory.keywordSearch(f.question, candidates), memory.vectorSearch(vectors[i]!, candidates)], [weight, 1]), f));
      const mrr = (c?: QueryClass) => mean(ranks.filter((_, i) => !c || facts[i]!.queryClass === c).map((r) => (r > 0 ? 1 / r : 0))).toFixed(3);
      rows.push([candidates, weight, pct(mean(ranks.map((r) => Number(r > 0 && r <= TOP_K)))), mrr(), mrr("exact"), mrr("reworded")]);
    }
  }
  memory.close();
  remove(path);
  console.log(table(rows));
}

async function scale(): Promise<void> {
  const rng = seeded(7);
  const vector = () => {
    const v = Array.from({ length: EMBEDDING_DIMENSIONS }, () => rng() - 0.5);
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  };
  const words = Array.from({ length: 5000 }, (_, i) => `word${i}`);
  const text = () => Array.from({ length: 60 }, () => words[Math.floor(rng() * words.length)]).join(" ");
  const rows: (string | number)[][] = [["items", "vector p50 ms", "vector p95 ms", "keyword p50 ms", "keyword p95 ms"]];
  const embedder: Embedder = { embed: async (inputs) => inputs.map(vector) };
  const results = [];
  for (const size of [1_000, 10_000]) {
    const path = tempFile();
    const memory = new Memory({ path, cwd: CWD, embedder });
    for (let i = 0; i < size; i++) memory.remember(text());
    while (await memory.embedPending());
    const time = (run: () => void) =>
      Array.from({ length: 200 }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
      });
    const vectorMs = time(() => memory.vectorSearch(vector()));
    const keywordMs = time(() => memory.keywordSearch(text().split(" ").slice(0, 6).join(" ")));
    memory.close();
    remove(path);
    const row = { size, vectorP50: percentile(vectorMs, 50), vectorP95: percentile(vectorMs, 95), keywordP50: percentile(keywordMs, 50), keywordP95: percentile(keywordMs, 95) };
    results.push(row);
    rows.push([size, row.vectorP50.toFixed(1), row.vectorP95.toFixed(1), row.keywordP50.toFixed(1), row.keywordP95.toFixed(1)]);
  }
  console.log(table(rows));
  saveResults("memory-scale", { results });
}

interface Answer {
  text: string;
  requests: number;
  tools: string[];
}

async function ask(question: string, provider: Provider, memory?: Memory): Promise<Answer> {
  const dir = mkdtempSync(join(tmpdir(), "autocode-memory-e2e-"));
  const shell = detectShell();
  const tools = new ToolRegistry(DEFAULT_TOOLS.filter((t) => t.kind !== "network"));
  if (memory) tools.add(memoryTools(memory));
  const agent = new Agent({
    provider,
    tools,
    permissions: new Permissions("auto", async () => "allow"),
    system: buildSystemPrompt(dir, shell),
    cwd: dir,
    shell,
    maxSteps: E2E_MAX_STEPS,
    projectContext: async () => (memory ? memorySection(memory.notes()) : ""),
  });
  const used: string[] = [];
  await agent.run(question, { onToolStart: (call, summary) => (used.push(call.name), console.error(`  ${call.name}(${summary.slice(0, 70)})`)), onNotice: (m) => console.error(`  ${m}`) });
  agent.dispose();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  const last = agent.messages.at(-1);
  const text = last?.role === "assistant" ? last.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : "";
  return { text, requests: agent.totalUsage.requests ?? 0, tools: used };
}

async function endToEnd(noise: string[], cap: number, modelSpec?: string): Promise<void> {
  const chosen = resolveModelSpec(loadConfig(), modelSpec);
  const provider = new CappedProvider(createProvider({ ...chosen.profile, requestsPerMinute: chosen.profile.requestsPerMinute ?? 6 }), cap);
  const answers: Record<string, Answer> = existsSync(ANSWERS_PATH) ? JSON.parse(readFileSync(ANSWERS_PATH, "utf8")) : {};
  const once = async (key: string, run: () => Promise<Answer>) => {
    if (answers[key]) return answers[key]!;
    console.error(`${key} (${provider.spent}/${cap} requests spent)`);
    answers[key] = await run();
    save(ANSWERS_PATH, answers);
    return answers[key]!;
  };

  const path = tempFile();
  const memory = new Memory({ path, cwd: CWD, embedder: new SavedEmbedder(geminiEmbedder()) });
  fill(memory, noise);
  while (await memory.embedPending());
  const answerable = FACTS.filter((f) => f.answer);
  const rows: (string | number)[][] = [["question", "kind", "memory off", "memory on", "tools with memory"]];
  const scored: { kind: string; off?: boolean; on: boolean }[] = [];
  const passes = (text: string, kind: string, answer?: RegExp) => (kind === "unanswerable" ? REFUSAL.test(text) : answer!.test(text));
  try {
    const questions = [...answerable.map((f) => ({ question: f.question, kind: f.queryClass as string, answer: f.answer })), ...UNANSWERABLE.map((question) => ({ question, kind: "unanswerable", answer: undefined }))];
    for (const [i, q] of questions.entries()) {
      const off = i < OFF_RUNS ? await once(`off:${q.question}`, () => ask(q.question, provider)) : undefined;
      const on = await once(`on:${q.question}`, () => ask(q.question, provider, memory));
      const row = { kind: q.kind, off: off && passes(off.text, q.kind, q.answer), on: passes(on.text, q.kind, q.answer) };
      scored.push(row);
      rows.push([q.question.slice(0, 50), q.kind, off ? (row.off ? "right" : "wrong") : "-", row.on ? "right" : "wrong", on.tools.join(" ")]);
    }
    const trips: boolean[] = [];
    for (const trip of ROUND_TRIPS) {
      const notesPath = tempFile();
      const notes = new Memory({ path: notesPath, cwd: CWD });
      const told = await once(`tell:${trip.tell}`, () => ask(trip.tell, provider, notes));
      // a saved answer means the note is gone with its temporary store, so it's rebuilt from the record
      const saved = answers[`saved:${trip.tell}`];
      if (saved) notes.remember(saved.text);
      else if (told.tools.includes("remember")) {
        const text = notes.notes()[0]?.text ?? "";
        answers[`saved:${trip.tell}`] = { text, requests: 0, tools: [] };
        save(ANSWERS_PATH, answers);
      }
      const later = await once(`ask:${trip.ask}`, () => ask(trip.ask, provider, notes));
      const right = trip.answer.test(later.text);
      trips.push(right);
      rows.push([trip.ask.slice(0, 50), "told earlier", "-", right ? "right" : "wrong", `${told.tools.join(" ")} / ${later.tools.join(" ")}`]);
      notes.close();
      remove(notesPath);
    }
    console.log(table(rows));
    const share = (kinds: (k: string) => boolean, which: "off" | "on") => {
      const group = scored.filter((s) => kinds(s.kind) && s[which] !== undefined);
      return `${group.filter((s) => s[which]).length}/${group.length}`;
    };
    const summary = {
      model: chosen.profile.model,
      answerableOff: share((k) => k !== "unanswerable", "off"),
      answerableOn: share((k) => k !== "unanswerable", "on"),
      refusedOn: share((k) => k === "unanswerable", "on"),
      toldEarlier: `${trips.filter(Boolean).length}/${trips.length}`,
      totalRequests: Object.values(answers).reduce((sum, a) => sum + a.requests, 0),
    };
    console.log(`\n${JSON.stringify(summary, null, 2)}`);
    saveResults("memory-e2e", { ...summary, answers });
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    console.error(`${err.message} Saved answers are kept; run again to continue.`);
  } finally {
    memory.close();
    remove(path);
  }
}

const { values: args } = parseArgs({
  options: { check: { type: "boolean" }, tune: { type: "boolean" }, scale: { type: "boolean" }, e2e: { type: "boolean" }, cap: { type: "string" }, model: { type: "string" } },
});
if (args.scale) await scale();
else {
  const noise = commitMessages();
  if (args.check) check(noise);
  else if (args.tune) await tune(noise);
  else if (args.e2e) await endToEnd(noise, Number(args.cap ?? E2E_CAP), args.model);
  else await retrieval(noise);
}
process.exit(0);
