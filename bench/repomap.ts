// Does the repo map point at the files a real commit went on to change? Replays commit history from
// open-source repos, building each map from the parent commit so it can't see the change. Spends no API quota.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RepoMap } from "../src/tools/repomap.js";
import { BENCH_DIR, bootstrapCI, hash, mean, pct, percentile, saveResults, seeded, table } from "./lib.js";

// chosen by language and size before any results existed, and pinned so a rerun sees the same history
const REPOS = [
  { url: "https://github.com/honojs/hono", language: "TypeScript", at: "c91b60a251186fb024557c6d55a11d8e388f179c" },
  { url: "https://github.com/fastify/fastify", language: "JavaScript", at: "8c0f699144187dab3b600a626829c31368762256" },
  { url: "https://github.com/encode/httpx", language: "Python", at: "b5addb64f0161ff6bfe94c124ef76f6a1fba5254" },
  { url: "https://github.com/pallets/flask", language: "Python", at: "49943b5a94413a530761350f04e896f76e8d620e" },
  { url: "https://github.com/spf13/cobra", language: "Go", at: "adbc8813901bba65827259daa8e22ff94ec1f30e" },
  { url: "https://github.com/junegunn/fzf", language: "Go", at: "99bfd5aa0f66133d7dcfbf18f8044eb765f04649" },
  { url: "https://github.com/BurntSushi/ripgrep", language: "Rust", at: "91f5d22ef48bde459d90a8c7dbeab416e97d0f2b" },
  { url: "https://github.com/google/gson", language: "Java", at: "57731049da3e415be3d5d34db1ca3b80f3c73810" },
];
const COMMITS_PER_REPO = 60;
const MAX_FILES_IN_COMMIT = 15;
const HISTORY_SCANNED = 3000;
const INJECTED_MAP_TOKENS = 1000;
const REPOS_DIR = join(BENCH_DIR, ".repos");
const RANKERS = ["repoMap", "sameDirectory", "recentlyEdited", "random"] as const;
type Ranker = (typeof RANKERS)[number];

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.longpaths=true", ...args], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 });

function clone(url: string, at: string): string {
  const dir = join(REPOS_DIR, url.split("/").pop()!);
  mkdirSync(REPOS_DIR, { recursive: true });
  if (!existsSync(dir)) execFileSync("git", ["clone", "--quiet", url, dir], { stdio: "inherit" });
  git(dir, "cat-file", "-e", at);
  return dir;
}

// the paths are what's left once the indented symbols and the "... more" lines are gone
const pathsIn = (map: string) => map.split("\n").filter((l) => l && !l.startsWith(" ") && !l.startsWith("... "));

function eligibleCommits(dir: string, head: string): { sha: string; changed: string[] }[] {
  const log = git(dir, "log", "--no-merges", "--first-parent", `-n${HISTORY_SCANNED}`, "--diff-filter=M", "--name-only", "--format=@%H", head);
  const commits: { sha: string; changed: string[] }[] = [];
  for (const block of log.split("@").slice(1)) {
    const [sha, ...files] = block.split("\n").filter(Boolean);
    if (files.length >= 2 && files.length <= MAX_FILES_IN_COMMIT) commits.push({ sha: sha!, changed: files });
  }
  return commits;
}

function recentlyEdited(dir: string, parent: string): string[] {
  const log = git(dir, "log", "-n300", "--name-only", "--format=", parent);
  return [...new Set(log.split("\n").filter(Boolean))];
}

function rank(ranker: Ranker, universe: string[], ctx: { seed?: string; map: string[]; recent: string[]; rng: () => number }): string[] {
  if (ranker === "repoMap") return ctx.map;
  if (ranker === "random") {
    const shuffled = [...universe];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(ctx.rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    return shuffled;
  }
  if (ranker === "recentlyEdited") {
    const order = new Map(ctx.recent.map((f, i) => [f, i]));
    return [...universe].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || a.localeCompare(b));
  }
  const dirs = (p: string) => p.split("/").slice(0, -1);
  const shared = (p: string) => {
    const seedDirs = dirs(ctx.seed ?? "");
    const pathDirs = dirs(p);
    let n = 0;
    while (n < seedDirs.length && seedDirs[n] === pathDirs[n]) n++;
    // closest directories first: a shared prefix counts for, and extra depth against
    return n * 100 - (seedDirs.length - n + pathDirs.length - n);
  };
  return [...universe].sort((a, b) => shared(b) - shared(a) || a.localeCompare(b));
}

const recallAt = (ranked: string[], wanted: string[], k: number) => wanted.filter((w) => ranked.slice(0, k).includes(w)).length / wanted.length;

interface Sample {
  repo: string;
  sha: string;
  universe: number;
  targets: number;
  focused: Record<Ranker, { recall5: number; recall10: number }>;
  injected: Partial<Record<Ranker, { hit: number; recall: number }>>;
  mapFiles: number;
  ms: number;
}

async function benchRepo({ url, language, at }: (typeof REPOS)[number]) {
  const dir = clone(url, at);
  const name = url.split("/").pop()!;
  const commits = eligibleCommits(dir, at);
  const rng = seeded(hash(name));
  const map = new RepoMap(dir);
  const samples: Sample[] = [];
  let skipped = 0;

  for (const { sha, changed } of commits) {
    if (samples.length >= COMMITS_PER_REPO) break;
    git(dir, "checkout", "--quiet", "--force", `${sha}~1`);

    // every file the map could list, so that all rankers choose from the same set
    const everything = pathsIn(await map.build({ maxTokens: 10_000_000 }));
    const wanted = changed.filter((f) => everything.includes(f));
    if (wanted.length < 2) {
      skipped++;
      continue;
    }
    const seed = wanted[Math.floor(rng() * wanted.length)]!;
    const targets = wanted.filter((f) => f !== seed);
    const universe = everything.filter((f) => f !== seed);

    const started = performance.now();
    const focusedMap = pathsIn(await map.build({ focus: [seed], maxTokens: 10_000_000 })).filter((f) => f !== seed);
    const ms = performance.now() - started;
    const injectedMap = pathsIn(await map.build({ maxTokens: INJECTED_MAP_TOKENS }));
    const recent = recentlyEdited(dir, `${sha}~1`);

    const focused = {} as Sample["focused"];
    const injected = {} as Sample["injected"];
    for (const r of RANKERS) {
      const ranked = rank(r, universe, { seed, map: focusedMap, recent, rng });
      focused[r] = { recall5: recallAt(ranked, targets, 5), recall10: recallAt(ranked, targets, 10) };
      // the map in the system prompt has no focus and so no seed, which leaves same-directory nothing to go on
      if (r === "sameDirectory") continue;
      // it shows as many files as fit its budget
      const shown = r === "repoMap" ? injectedMap : rank(r, everything, { seed, map: injectedMap, recent, rng }).slice(0, injectedMap.length);
      const recall = recallAt(shown, wanted, shown.length);
      injected[r] = { hit: recall > 0 ? 1 : 0, recall };
    }
    samples.push({ repo: name, sha, universe: everything.length, targets: targets.length, focused, injected, mapFiles: injectedMap.length, ms });
    if (samples.length % 20 === 0) console.error(`${name}: ${samples.length}/${COMMITS_PER_REPO}`);
  }
  git(dir, "checkout", "--quiet", "--force", at);
  // grammars are already loaded by now, so this is the parsing alone, not a process starting from nothing
  const started = performance.now();
  await new RepoMap(dir).build();
  const fullParseMs = performance.now() - started;
  return { name, language, at, samples, skipped, fullParseMs, sourceFiles: samples.at(-1)?.universe ?? 0 };
}

interface Stat {
  mean: number;
  low: number;
  high: number;
}

function summarize(samples: Sample[]) {
  const stat = (values: number[]) => {
    const [low, high] = bootstrapCI(values);
    return { mean: mean(values), low, high };
  };
  return Object.fromEntries(
    RANKERS.map((r) => [
      r,
      {
        focusedRecallAt5: stat(samples.map((s) => s.focused[r].recall5)),
        focusedRecallAt10: stat(samples.map((s) => s.focused[r].recall10)),
        ...(r === "sameDirectory"
          ? {}
          : {
              injectedHitRate: stat(samples.map((s) => s.injected[r]!.hit)),
              injectedRecall: stat(samples.map((s) => s.injected[r]!.recall)),
            }),
      },
    ]),
  ) as Record<Ranker, Record<"focusedRecallAt5" | "focusedRecallAt10", Stat> & Partial<Record<"injectedHitRate" | "injectedRecall", Stat>>>;
}

const repos = [];
for (const repo of REPOS) {
  console.error(`${repo.url}...`);
  repos.push(await benchRepo(repo));
}
const all = repos.flatMap((r) => r.samples);
const overall = summarize(all);
const interval = (s?: Stat) => (s ? `${pct(s.mean)} (${pct(s.low)}-${pct(s.high)})` : "n/a");

console.log(`${all.length} commits from ${repos.length} repos\n`);
console.log(
  table([
    ["ranker", "focused recall@5", "focused recall@10", "injected map hit", "injected map recall"],
    ...RANKERS.map((r) => [r, interval(overall[r].focusedRecallAt5), interval(overall[r].focusedRecallAt10), interval(overall[r].injectedHitRate), interval(overall[r].injectedRecall)]),
  ]),
);
console.log(
  `\n${table([
    ["repo", "language", "commits", "files", "map files", "recall@10 map", "same dir", "recent", "random", "full parse"],
    ...repos.map((r) => {
      const s = summarize(r.samples);
      return [
        r.name,
        r.language,
        r.samples.length,
        r.sourceFiles,
        Math.round(mean(r.samples.map((x) => x.mapFiles))),
        pct(s.repoMap.focusedRecallAt10.mean),
        pct(s.sameDirectory.focusedRecallAt10.mean),
        pct(s.recentlyEdited.focusedRecallAt10.mean),
        pct(s.random.focusedRecallAt10.mean),
        `${Math.round(r.fullParseMs)}ms`,
      ];
    }),
  ])}`,
);

saveResults("repomap", {
  commits: all.length,
  maxFilesInCommit: MAX_FILES_IN_COMMIT,
  injectedMapTokens: INJECTED_MAP_TOKENS,
  overall,
  focusedBuildMsP50: percentile(all.map((s) => s.ms), 50),
  repos: repos.map((r) => ({ name: r.name, language: r.language, at: r.at, commits: r.samples.length, skipped: r.skipped, sourceFiles: r.sourceFiles, fullParseMs: r.fullParseMs, ...summarize(r.samples) })),
});
process.exit(0);
