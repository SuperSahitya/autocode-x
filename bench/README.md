# Benchmarks

```
npm run bench:retry
npm run bench:repomap
npm run bench:compaction
npm run eval
```

Retry and repo map use no API quota. Compaction uses 24 requests. Output goes to `results/`, which isn't committed.

## Retries

A 5-step task against a local server that fails on purpose, 200 runs per failure rate. No tool ran twice.

| Failed requests | Completed | Without retries |
|---|---|---|
| 10% | 100% | 54.5% |
| 25% | 100% | 16.0% |
| 50% | 99.5% | 0.5% |

## Compaction

6 scripted sessions of about 52k tokens, with 10 facts to recall in each, on `gemini-3.5-flash-lite`.

| Context | Tokens | Facts recalled |
|---|---|---|
| Full session | 52,408 | 95.0% |
| Compacted | 4,982 | 65.0% |
| Oldest messages dropped | 4,604 | 16.7% |

## Repo map

480 commits from 8 open-source repos. Given one changed file, how many of the others are in the top 10?

| Ranking | Recall |
|---|---|
| Recently edited | 50.4% |
| Repo map | 47.7% |
| Same directory | 44.2% |
| Random | 21.3% |

About twice as good as random, but no better than the simple baselines.

## Eval

10 small coding tasks, each scored by a check the agent can't see, on `gemini-3.5-flash-lite`. One run per task. `--features-off` turns off the repo map, trimming and compaction.

| | Passed | Requests | Input tokens |
|---|---|---|---|
| Features on | 9 of 10 | 118 | 434,844 |
| Features off | 9 of 10 | 128 | 541,992 |

The failure is `03-json-flag`, in both runs, and it's model behaviour: the flag works, but the model sometimes changes the plain output as well. It passed 1 of 3 attempts.

The token difference could be noise, and these repos are too small to need a map or to trigger compaction.
