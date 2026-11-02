// Runs the real agent and HTTP client against a local model that fails on purpose. Spends no API quota.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { ToolRegistry } from "../src/tools/index.js";
import { detectShell } from "../src/tools/shell.js";
import { defineTool } from "../src/tools/types.js";
import { hash, mean, pct, percentile, pool, saveResults, seeded, table } from "./lib.js";

const STEPS = 5;
const RUNS = 200;
const RATES = [0.1, 0.25, 0.5];
const FINAL_ANSWER = "All five steps are recorded and the work is finished.";
const FAULTS = ["429_with_delay", "429_no_delay", "503", "connection_reset", "stream_dropped", "stream_truncated"] as const;
type Fault = (typeof FAULTS)[number];

interface RunLog {
  requests: number;
  faults: Fault[];
  earlyRetries: number;
  notBefore: number;
  rng: () => number;
}

const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const toolCall = (args: string) => ({ tool_calls: [{ index: 0, id: `call_${args.length}`, type: "function", function: { name: "record", arguments: args } }] });

function respond(res: ServerResponse, step: number): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (step < STEPS) res.write(chunk(toolCall(JSON.stringify({ step }))) + chunk({}, "tool_calls"));
  else res.write(chunk({ content: FINAL_ANSWER }) + chunk({}, "stop"));
  res.end("data: [DONE]\n\n");
}

// half a response, as when a connection dies partway through
function respondPartly(res: ServerResponse, step: number): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk(step < STEPS ? toolCall(`{"st`) : { content: FINAL_ANSWER.slice(0, 20) }));
}

function inject(fault: Fault, log: RunLog, res: ServerResponse, step: number): void {
  switch (fault) {
    case "429_with_delay":
      log.notBefore = Date.now() + 1000;
      return void res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Rate limited", details: [{ retryDelay: "1s" }] } }));
    case "429_no_delay":
      return void res.writeHead(429).end("Too many requests");
    case "503":
      return void res.writeHead(503).end("Overloaded");
    case "connection_reset":
      return void res.socket?.destroy();
    case "stream_dropped":
      respondPartly(res, step);
      return void setTimeout(() => res.socket?.destroy(), 5);
    case "stream_truncated":
      // closed cleanly, so nothing at the HTTP level says the response is incomplete
      respondPartly(res, step);
      return void res.end();
  }
}

async function startModel(rate: number) {
  const logs = new Map<string, RunLog>();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const { model, messages } = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
    let log = logs.get(model);
    if (!log) logs.set(model, (log = { requests: 0, faults: [], earlyRetries: 0, notBefore: 0, rng: seeded(hash(`${rate}:${model}`)) }));
    log.requests++;
    if (Date.now() < log.notBefore) log.earlyRetries++;
    log.notBefore = 0;

    const step = messages.filter((m) => m.role === "tool" && m.content === "recorded").length;
    if (log.rng() < rate) {
      const fault = FAULTS[Math.floor(log.rng() * FAULTS.length)]!;
      log.faults.push(fault);
      inject(fault, log, res, step);
    } else respond(res, step);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs, close: () => server.closeAllConnections() ?? server.close() };
}

async function runAgent(baseUrl: string, model: string) {
  const executed: number[] = [];
  const record = defineTool({
    name: "record",
    kind: "read",
    description: "Records a step. Stands in for a tool with side effects, which must not run twice.",
    schema: z.object({ step: z.number() }),
    summarize: (i) => String(i.step),
    async run({ step }) {
      executed.push(step);
      return "recorded";
    },
  });
  const agent = new Agent({
    provider: new OpenAIProvider({ model, baseUrl }),
    tools: new ToolRegistry([record]),
    permissions: new Permissions("auto", async () => "allow"),
    system: "bench",
    cwd: process.cwd(),
    shell: detectShell(),
    maxSteps: 30,
  });
  const started = Date.now();
  let error: string | undefined;
  await agent.run("go").catch((err: Error) => (error = err.message));
  const last = agent.messages.at(-1);
  const text = last?.role === "assistant" ? last.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : "";
  return { executed, text, error, ms: Date.now() - started };
}

async function faultRun(rate: number) {
  const model = await startModel(rate);
  const runs = await pool(
    Array.from({ length: RUNS }, (_, i) => `run-${i}`),
    50,
    async (id) => ({ id, ...(await runAgent(model.url, id)) }),
  );
  model.close();

  const inOrder = (e: number[]) => e.length === STEPS && e.every((s, i) => s === i);
  const outcomes = runs.map((r) => {
    const log = model.logs.get(r.id)!;
    return {
      completed: !r.error && inOrder(r.executed) && r.text === FINAL_ANSWER,
      silentlyWrong: !r.error && r.text !== FINAL_ANSWER,
      duplicateTools: new Set(r.executed).size !== r.executed.length,
      survivesWithoutRetries: log.faults.length === 0,
      ...r,
      log,
    };
  });
  const byFault = Object.fromEntries(FAULTS.map((f) => [f, outcomes.reduce((n, o) => n + o.log.faults.filter((x) => x === f).length, 0)]));
  const errors = outcomes.filter((o) => o.error).map((o) => o.error!.slice(0, 120));
  return {
    faultRate: rate,
    runs: RUNS,
    completionRate: mean(outcomes.map((o) => Number(o.completed))),
    // a run with even one fault fails if the client doesn't retry, so this needs no second run
    completionRateWithoutRetries: mean(outcomes.map((o) => Number(o.survivesWithoutRetries))),
    faultsInjected: outcomes.reduce((n, o) => n + o.log.faults.length, 0),
    byFault,
    silentlyWrongAnswers: outcomes.filter((o) => o.silentlyWrong).length,
    runsWithDuplicateToolCalls: outcomes.filter((o) => o.duplicateTools).length,
    retriesBeforeTheServerAskedFor: outcomes.reduce((n, o) => n + o.log.earlyRetries, 0),
    requestsPerRun: mean(outcomes.map((o) => o.log.requests)),
    medianSeconds: percentile(outcomes.map((o) => o.ms), 50) / 1000,
    p95Seconds: percentile(outcomes.map((o) => o.ms), 95) / 1000,
    failures: errors,
  };
}

// faults where retrying would only waste quota, so exactly one request should go out
async function failFast() {
  const cases: Record<string, { status: number; body: string }> = {
    "daily quota used up": { status: 429, body: JSON.stringify({ error: { message: "GenerateRequestsPerDay exceeded" } }) },
    "billing problem": { status: 429, body: JSON.stringify({ error: { code: "insufficient_quota", message: "Check your billing details" } }) },
    "wait longer than 2 minutes": { status: 429, body: JSON.stringify({ error: { message: "Slow down", details: [{ retryDelay: "600s" }] } }) },
    "bad API key": { status: 401, body: JSON.stringify({ error: { message: "Invalid key" } }) },
  };
  const rows = [];
  for (const [name, { status, body }] of Object.entries(cases)) {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { error, ms } = await runAgent(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "m");
    server.closeAllConnections();
    server.close();
    rows.push({ name, requests, ms, failedWithError: error !== undefined });
  }
  return rows;
}

const results = [];
for (const rate of RATES) {
  console.error(`fault rate ${pct(rate)}...`);
  results.push(await faultRun(rate));
}
const fast = await failFast();

console.log(
  table([
    ["faults", "runs", "with retries", "without", "silently wrong", "duplicate tools", "early retries", "requests/run", "median", "p95"],
    ...results.map((r) => [
      pct(r.faultRate),
      r.runs,
      pct(r.completionRate),
      pct(r.completionRateWithoutRetries),
      r.silentlyWrongAnswers,
      r.runsWithDuplicateToolCalls,
      r.retriesBeforeTheServerAskedFor,
      r.requestsPerRun.toFixed(1),
      `${r.medianSeconds.toFixed(1)}s`,
      `${r.p95Seconds.toFixed(1)}s`,
    ]),
  ]),
);
console.log(`\n${table([["should fail fast", "requests", "ms"], ...fast.map((f) => [f.name, f.requests, f.ms])])}`);
for (const r of results) if (r.failures.length) console.log(`\nfailures at ${pct(r.faultRate)}:\n  ${[...new Set(r.failures)].join("\n  ")}`);

saveResults("retry", { stepsPerRun: STEPS, results, failFast: fast });
process.exit(0);
