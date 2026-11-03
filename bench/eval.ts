// Gives the real agent small coding tasks in throwaway folders, then runs a check it never saw.
//   npm run eval -- --verify        every check fails on the starting code and passes on the solution
//   npm run eval -- --mock          the whole pipeline, with a fake model that writes the solution
//   npm run eval                    real model; answers are saved, so a rerun skips finished tasks
//   npm run eval -- --only csv      just the tasks whose name contains this
//   npm run eval -- --cap 150       stop after this many model requests
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { buildSystemPrompt, repoMapSection } from "../src/agent/prompt.js";
import { createProvider, loadConfig, resolveModelSpec } from "../src/config.js";
import { DEFAULT_TOOLS, ToolRegistry } from "../src/tools/index.js";
import { repoMapFor } from "../src/tools/repomap.js";
import { detectShell } from "../src/tools/shell.js";
import type { ChatRequest, Provider, StreamEvent } from "../src/types.js";
import { runProcess } from "../src/util/process.js";
import { BENCH_DIR, bootstrapCI, mean, pct, percentile, saveResults, table } from "./lib.js";

const MAX_STEPS = 20;
const DEFAULT_CAP = 150;
const CHECK_FILE = "eval-check.test.mjs";
const TASKS_DIR = join(BENCH_DIR, "eval", "tasks");
const RAW_PATH = join(BENCH_DIR, "results", "eval-raw.json");

interface Task {
  name: string;
  kind: string;
  prompt: string;
  repo: Map<string, string>;
  solution: Map<string, string>;
  check: string;
}

function parseTask(file: string): Task {
  const parts = readFileSync(join(TASKS_DIR, file), "utf8").replace(/\r\n/g, "\n").split(/^-- (.+) --\n/m);
  const [kindLine, ...prompt] = parts[0]!.trim().split("\n");
  const task: Task = { name: file.replace(/\.txt$/, ""), kind: kindLine!.replace("kind: ", ""), prompt: prompt.join("\n"), repo: new Map(), solution: new Map(), check: "" };
  for (let i = 1; i < parts.length; i += 2) {
    const [path, body] = [parts[i]!, parts[i + 1]!];
    if (path === "check.test.mjs") task.check = body;
    else if (path.startsWith("repo/")) task.repo.set(path.slice(5), body);
    else if (path.startsWith("solution/")) task.solution.set(path.slice(9), body);
    else throw new Error(`${file}: unexpected section ${path}`);
  }
  return task;
}

function writeFiles(dir: string, files: Map<string, string>): void {
  for (const [path, body] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

function workspace(task: Task): string {
  const dir = mkdtempSync(join(tmpdir(), "autocode-eval-"));
  writeFiles(dir, task.repo);
  return dir;
}

// only added once the agent is done, so it can't read or edit what it's being judged on
async function runCheck(dir: string, task: Task): Promise<{ passed: boolean; output: string }> {
  writeFileSync(join(dir, CHECK_FILE), task.check);
  const { exitCode, output } = await runProcess(process.execPath, ["--test", CHECK_FILE], { cwd: dir, timeoutMs: 60_000 });
  return { passed: exitCode === 0, output: output.slice(-1500) };
}

const remove = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });

async function verify(tasks: Task[]): Promise<void> {
  const rows = [];
  let bad = 0;
  for (const task of tasks) {
    const dir = workspace(task);
    const before = await runCheck(dir, task);
    writeFiles(dir, task.solution);
    const after = await runCheck(dir, task);
    remove(dir);
    if (before.passed || !after.passed) {
      bad++;
      console.log(`${task.name}\n${after.output}`);
    }
    rows.push([task.name, task.kind, before.passed ? "PASSES (bad)" : "fails", after.passed ? "passes" : "FAILS (bad)"]);
  }
  console.log(table([["task", "kind", "starting code", "solution"], ...rows]));
  process.exit(bad ? 1 : 0);
}

/** Stands in for a model: reads the files it's about to replace, writes the solution, says it's done. */
class SolutionProvider implements Provider {
  readonly name = "mock";
  readonly model = "writes-the-solution";
  private step = 0;

  constructor(private readonly task: Task) {}

  async listModels() {
    return [this.model];
  }

  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    const usage = { inputTokens: 10, outputTokens: 10 };
    const paths = [...this.task.solution.keys()];
    const call = (name: string, input: unknown, i: number): StreamEvent => ({ type: "tool_call", call: { type: "tool_call", id: `${name}_${i}`, name, input } });
    if (this.step === 0) {
      yield* paths.filter((p) => this.task.repo.has(p)).map((path, i) => call("read_file", { path }, i));
    } else if (this.step === 1) {
      yield* paths.map((path, i) => call("write_file", { path, content: this.task.solution.get(path) }, i));
    } else yield { type: "text", delta: "Done." };
    yield { type: "done", stopReason: this.step++ < 2 ? "tool_use" : "end_turn", usage };
  }
}

class BudgetExhausted extends Error {}

/** Counts every request, resends included, and refuses to send past the cap. */
class CappedProvider implements Provider {
  spent = 0;

  constructor(
    private readonly inner: Provider,
    private readonly cap: number,
  ) {}

  get name() {
    return this.inner.name;
  }
  get model() {
    return this.inner.model;
  }
  listModels() {
    return this.inner.listModels();
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    if (this.spent >= this.cap) throw new BudgetExhausted(`Reached the cap of ${this.cap} requests.`);
    this.spent++;
    yield* this.inner.stream({
      ...req,
      onRetry: (message) => {
        this.spent++;
        req.onRetry?.(message);
      },
    });
  }
}

interface TaskResult {
  name: string;
  kind: string;
  passed: boolean;
  /** the agent ran out of steps, or the provider failed for good */
  stoppedBy?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  seconds: number;
  checkOutput?: string;
}

async function runTask(task: Task, provider: Provider): Promise<TaskResult> {
  const dir = workspace(task);
  const shell = detectShell();
  const agent = new Agent({
    provider,
    // nothing here needs the web, and it keeps runs from depending on what a site says today
    tools: new ToolRegistry(DEFAULT_TOOLS.filter((t) => t.kind !== "network")),
    permissions: new Permissions("auto", async () => "allow"),
    system: buildSystemPrompt(dir, shell),
    cwd: dir,
    shell,
    maxSteps: MAX_STEPS,
    projectContext: async (signal) => repoMapSection(await repoMapFor(dir).build({ signal })),
  });
  let toolCalls = 0;
  const started = Date.now();
  let stoppedBy: string | undefined;
  try {
    await agent.run(task.prompt, {
      onToolStart: (call, summary) => {
        toolCalls++;
        console.error(`  ${call.name}(${summary})`);
      },
      onNotice: (message) => console.error(`  ${message}`),
    });
    if (agent.messages.at(-1)?.role === "user") stoppedBy = `reached ${MAX_STEPS} steps`;
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      agent.dispose();
      remove(dir);
      throw err;
    }
    stoppedBy = (err as Error).message.slice(0, 300);
  }
  const seconds = (Date.now() - started) / 1000;
  agent.dispose();
  const { passed, output } = await runCheck(dir, task);
  remove(dir);
  const { requests = 0, inputTokens, outputTokens, cacheReadTokens = 0 } = agent.totalUsage;
  return {
    name: task.name,
    kind: task.kind,
    passed,
    stoppedBy,
    requests,
    inputTokens: inputTokens + cacheReadTokens,
    outputTokens,
    toolCalls,
    seconds,
    checkOutput: passed ? undefined : output,
  };
}

const { values: args } = parseArgs({
  options: {
    verify: { type: "boolean" },
    mock: { type: "boolean" },
    only: { type: "string" },
    cap: { type: "string" },
    model: { type: "string" },
  },
});

const tasks = readdirSync(TASKS_DIR)
  .filter((f) => f.endsWith(".txt"))
  .sort()
  .map(parseTask)
  .filter((t) => !args.only || t.name.includes(args.only));
if (args.verify) await verify(tasks);

const config = loadConfig();
const chosen = resolveModelSpec(config, args.model);
const modelName = args.mock ? "mock" : chosen.profile.model;
const cap = Number(args.cap ?? DEFAULT_CAP);
const real = args.mock ? undefined : new CappedProvider(createProvider({ ...chosen.profile, requestsPerMinute: chosen.profile.requestsPerMinute ?? 6 }), cap);

// a failure of the provider says nothing about the agent, so those tasks run again next time
const saved: Record<string, TaskResult> = !args.mock && existsSync(RAW_PATH) ? JSON.parse(readFileSync(RAW_PATH, "utf8")) : {};
const results: TaskResult[] = [];
for (const task of tasks) {
  if (saved[task.name]) {
    results.push(saved[task.name]!);
    continue;
  }
  console.error(`${task.name}${real ? ` (${real.spent}/${cap} requests spent)` : ""}`);
  try {
    const result = await runTask(task, real ?? new SolutionProvider(task));
    results.push(result);
    if (real && !(result.stoppedBy && !result.stoppedBy.startsWith("reached"))) {
      saved[task.name] = result;
      mkdirSync(dirname(RAW_PATH), { recursive: true });
      writeFileSync(RAW_PATH, `${JSON.stringify(saved, null, 2)}\n`);
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    console.error(err.message);
    break;
  }
}

console.log(
  table([
    ["task", "kind", "result", "requests", "tools", "input tokens", "seconds"],
    ...results.map((r) => [r.name, r.kind, r.passed ? "pass" : r.stoppedBy ? `FAIL (${r.stoppedBy.slice(0, 40)})` : "FAIL", r.requests, r.toolCalls, r.inputTokens, Math.round(r.seconds)]),
  ]),
);
if (!results.length) process.exit(0);
const passes = results.map((r) => Number(r.passed));
const [low, high] = bootstrapCI(passes);
const requests = results.map((r) => r.requests);
console.log(`\n${passes.reduce((a, b) => a + b, 0)}/${results.length} passed (${pct(mean(passes))}, 95% CI ${pct(low)}-${pct(high)}), model ${modelName}`);
console.log(`Requests per task: mean ${mean(requests).toFixed(1)}, max ${percentile(requests, 100)}; total ${requests.reduce((a, b) => a + b, 0)}`);

// a partial run or a mock shouldn't replace the real results
const complete = results.length === tasks.length && results.every((r) => !r.stoppedBy || r.stoppedBy.startsWith("reached"));
if (!args.mock && !args.only && complete) {
  saveResults("eval", { model: modelName, maxSteps: MAX_STEPS, passRate: mean(passes), passRateLow: low, passRateHigh: high, totalRequests: requests.reduce((a, b) => a + b, 0), results });
}
process.exit(0);
