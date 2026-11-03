import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRequest, Provider, StreamEvent } from "../src/types.js";

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url));

/** mulberry32, so every run of a benchmark sees the same choices */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

/** 95% confidence interval of the mean, by resampling. */
export function bootstrapCI(values: number[], seed = 1, rounds = 2000): [number, number] {
  const rng = seeded(seed);
  const means: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(rng() * values.length)]!;
    means.push(sum / values.length);
  }
  return [percentile(means, 2.5), percentile(means, 97.5)];
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function table(rows: (string | number)[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((cell, c) => String(cell).padEnd(widths[c]!)).join("  ").trimEnd()).join("\n");
}

export async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]!);
      }
    }),
  );
  return out;
}

export function saveResults(name: string, data: object): void {
  const path = join(BENCH_DIR, "results", `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const commit = execSync("git describe --always --dirty", { encoding: "utf8" }).trim();
  writeFileSync(path, `${JSON.stringify({ commit, ...data }, null, 2)}\n`);
  console.log(`\nSaved ${path}`);
}

export class BudgetExhausted extends Error {}

/** Counts every request, resends included, and refuses to send past the cap. */
export class CappedProvider implements Provider {
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
