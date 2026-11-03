# Benchmarks

```
npm run bench:retry        # about 4 min, no API quota
npm run bench:repomap      # about 10 min, clones 8 repos into bench/.repos, no API quota
npm run bench:compaction   # 4 model requests per session, cached in results/compaction-raw.json
```

`npm run eval` is separate: see [Eval](#eval).

Everything below is from commit `2a279aa`.

## Retries

The real agent and HTTP client run a 5-step task against a local server that injects 429s, 503s, connection resets, and streams that drop or close early. 200 runs per fault rate. A run passes only if every step ran exactly once and the final answer is complete. Without retries, any fault fails the run, so that column is the share of runs that saw no faults.

| Faults per request | With retries | Without | Wrong answers | Tools run twice |
|---|---|---|---|---|
| 10% | 100% | 54.5% | 0 | 0 |
| 25% | 100% | 16.0% | 0 | 0 |
| 50% | 97.0% | 0.5% | 0 | 0 |

No retry arrived before the delay the server asked for. A used-up daily quota, a billing error, a wait over 2 minutes and a bad key each stop after 1 request.

This benchmark found a bug: a stream closed early was accepted as a full answer, giving 28 wrong answers in 200 runs at 50% faults, and 86% completion. Fixed in `b5e0305`.

Stalled streams aren't covered, since the timeout is 3 minutes.

## Compaction

6 scripted coding sessions of about 52k tokens, with real file contents and 10 made-up facts each, spread evenly from start to end. Each session is trimmed and summarized the way the agent does it at a 32k limit, then the model (`gemini-3.5-flash-lite`) answers questions about the facts. The baseline drops the oldest messages to reach the same size. Answers are scored by regex.

| Context | Tokens | Correct | Said unknown | Wrong |
|---|---|---|---|---|
| Full session | 52,408 | 95.0% | 3.3% | 1.7% |
| Compacted | 4,982 | 65.0% (CI 53-77%) | 31.7% | 3.3% |
| Oldest dropped | 4,604 | 16.7% (CI 8-27%) | 83.3% | 0% |

| Fact | Full | Compacted | Oldest dropped |
|---|---|---|---|
| User constraint | 100% | 100% | 0% |
| Command | 100% | 83.3% | 66.7% |
| Assistant decision | 83.3% | 75.0% | 0% |
| File changed | 100% | 66.7% | 0% |
| Tool output | 100% | 33.3% | 26.7% |
| File content | 83.3% | 33.3% | 33.3% |

User requests are copied into the summary rather than left to the model, which is why constraints score 100%. File content is meant to be read again, so it's dropped on purpose. Exact values from tool output are the weak spot. The sessions and questions are written by hand, and it's one model with 60 facts.

## Repo map

Replays 480 commits from 8 open-source repos (TypeScript, JavaScript, Python, Go, Rust, Java), building each map from the parent commit. Commits touch 2 to 15 files, and only modified source files count.

Focused: given one changed file, how many of the others appear in the top 10?

| Ranking | Recall@5 | Recall@10 |
|---|---|---|
| Recently edited (git log) | 34.2% | 50.4% (CI 47-54%) |
| Repo map | 33.2% | 47.7% (CI 44-52%) |
| Same directory | 29.0% | 44.2% (CI 41-48%) |
| Random | 9.9% | 21.3% (CI 18-25%) |

Injected: with no focus, does the 1000-token map in the system prompt show a file the commit changed?

| Ranking | At least one | Share of changed files |
|---|---|---|
| Recently edited | 66.0% | 41.4% |
| Repo map | 62.3% | 34.6% |
| Random | 36.0% | 15.6% |

The map is about 2x random, but not better than the simple baselines overall, and which ranking wins varies by repo. It also doesn't show whether the agent finishes tasks more often. A focused rebuild takes a median of 107ms, and parsing a repo takes 212ms to 1.5s.

## Eval

10 small coding tasks in `eval/tasks`: bug fixes, features, refactors and one implementation from a spec. The real agent works in a throwaway folder with web tools off and a limit of 20 steps. A task passes if a check the agent never saw passes afterwards.

```
npm run eval -- --verify        # each check fails on the starting code and passes on the solution
npm run eval -- --mock          # the whole pipeline with a fake model, no quota
npm run eval                    # real model, stops at 150 requests, finished tasks are saved and skipped
npm run eval -- --only csv
npm run eval -- --cap 50
```
