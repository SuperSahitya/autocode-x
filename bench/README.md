# Benchmarks

```
npm run bench:retry
npm run bench:repomap
npm run bench:compaction
npm run bench:memory
npm run bench:memory -- --e2e
npm run eval
```

Retry and repo map use no API quota. Compaction uses 24 requests. Memory uses about 7 embedding requests, and `--e2e` about 100 model requests. It reads commit messages from the repos `bench:repomap` clones. Output goes to `results/`, which isn't committed.

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

## Memory

455 items: 45 facts with a question each, 30 close distractors and 380 real commit messages. I wrote the facts and questions, so treat these as a small test, not a general result. Embeddings are `gemini-embedding-2` at 768 dimensions.

| Questions | Keyword recall@5 | Vector recall@5 | Hybrid recall@5 |
|---|---|---|---|
| Share an identifier with the answer (15) | 100% | 100% | 100% |
| Share some words (15) | 100% | 100% | 100% |
| Reworded, no shared words (15) | 0% | 100% | 100% |
| All (45) | 66.7% | 100% | 100% |

Keyword search can't find the reworded ones by design. Hybrid doesn't beat vector search here: MRR@5 is 0.850 against 0.944, or 0.808 against 0.935 on the 23 questions held out when picking its settings. It's slightly ahead only on near-identical identifiers (0.867 against 0.833).

New sessions on `gemini-3.5-flash-lite`, one run per question:

| | Right |
|---|---|
| Answer is in memory, memory off | 0 of 7 |
| Answer is in memory, memory on | 8 of 8 |
| Told in one session, asked in the next | 3 of 3 |
| Nothing to find, says there's no record | 2 of 2 |

With nothing to find, the model used to keep searching until the 6-step limit and never answer, even when the tool description told it to stop. Limiting `recall` to 3 searches per request fixed that in these two questions. No answerable question used more than 2 searches, so those weren't run again.

## Eval

10 small coding tasks, each scored by a check the agent can't see, on `gemini-3.5-flash-lite`. One run per task. `--features-off` turns off the repo map, trimming and compaction.

| | Passed | Requests | Input tokens |
|---|---|---|---|
| Features on | 9 of 10 | 118 | 434,844 |
| Features off | 9 of 10 | 128 | 541,992 |

The failure is `03-json-flag`, in both runs, and it's model behaviour: the flag works, but the model sometimes changes the plain output as well. It passed 1 of 3 attempts.

The token difference could be noise, and these repos are too small to need a map or to trigger compaction.
