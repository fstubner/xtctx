# Ingest / search scale bench

**Not run in CI.** Invoke explicitly:

```
BENCH=1 npm run bench:ingest
```

The test generates a 1000-session synthetic corpus via the deterministic eval
corpus generator, ingests through the real `EmbeddingService` + `LanceStore`
path, and then replays ~100 synthetic queries through `HybridSearch`.

Output lands in `tests/bench/baseline.json` with:

| field               | meaning                                   |
| ------------------- | ----------------------------------------- |
| `ingestMs`          | wall time for embed + upsert loop         |
| `ingestChunksPerSec`| derived throughput                        |
| `peakRssBytes`      | max RSS sampled at 1 Hz during ingest     |
| `footprintBytes`    | LanceDB on-disk directory size            |
| `searchP50Ms`       | p50 latency over ~100 hybrid searches     |
| `searchP95Ms`       | p95 latency over the same set             |

This iteration captures a baseline only — **no assertions yet**. Once a few
runs across machines are on record we will gate regressions (e.g. p95 must
not grow by more than 25%, peak RSS must not grow by more than 10%) and wire
the bench into release verification.
