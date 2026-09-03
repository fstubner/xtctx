# Testing strategy

What each suite defends, what it structurally cannot catch, and how that was
measured rather than assumed.

## The suites

| Suite | Command | Runs in CI | Defends |
|---|---|---|---|
| unit | `npm test` | every job | Parsing, scoping, ranking mechanics, config writing. The bulk of the suite. |
| integration | `npm run test:integration` | yes | The MCP tool handlers against a real index. |
| drift | `npm run test:drift` | yes | Each scraper against a recorded sample of the tool's real on-disk format. |
| smoke | `npm run test:smoke` | yes | The built CLI, spawned as a host tool spawns it, against seeded stores. |
| eval | `npm run test:eval` | `checks` job | Retrieval *quality* — MRR, top-1, recall@5 against a committed baseline. |
| security | `npm run test:security` | yes | Path containment, prompt-injection fencing, atomic writes. |

`npm test` deliberately excludes smoke, drift and eval: they build, spawn
processes and load a real embedding model. Everything is run before merge —
nothing is CI-only in the sense of never running — but a developer running
`npm test` locally is not running the same thing CI runs.

## What each layer cannot catch

Named because each of these has actually shipped a defect.

- **Unit tests cannot catch wiring.** They construct the object under test
  directly, so they pass while the thing that builds it in production is
  wrong. Setup wrote an MCP server and a hook and the tools were still refused
  because a permission list was missing; the session-start hook forked a
  background scan that never survived under a real host. Both had green unit
  tests. This is what the smoke suite is for, and why it spawns the built CLI
  rather than importing it.
- **Fixtures cannot catch format drift.** A scraper test feeds the parser a
  shape someone wrote by hand, which is the shape the parser already expects.
  The drift suite exists because transcript formats belong to other vendors
  and change without notice.
- **Nothing here catches a host tool's own behaviour.** Whether Claude Code
  applies `permissions.allow` in an untrusted workspace, whether it tears down
  a hook's process tree — those were found by running the product against real
  tools, and no suite in this repo can assert them. When a change depends on
  host behaviour, run it against the host.
- **The eval measures quality, not correctness.** It will notice ranking
  getting worse. It will not notice a session going missing.

## Mutation, not coverage percentage

Coverage is measured here by breaking code and checking something goes red. A
line-coverage number cannot distinguish a line that is executed from a line
that is *defended*, and every real gap found in this repo was found the second
way.

A sweep on 2026-09-03 changed ten load-bearing constants one at a time and ran
each suite against each mutation:

| Mutation | unit | eval | Outcome |
|---|---|---|---|
| confidence gate to 0 | killed | — | covered |
| result limit clamped to 1 | killed | — | covered |
| retrieval-unit reconcile disabled | killed | — | covered |
| corroboration weight to 0 | **survived** | killed | eval-only — now also unit |
| tie-break weight to 0.9 | **survived** | killed | eval-only — now also unit |
| window stride to no overlap | **survived** | killed | eval-only — now also unit |
| candidate windows per session to 1 | **survived** | killed | eval-only |
| matches per session to 1 | **survived** | **survived** | gap — now closed |
| resume cursor overlap to 0 | **survived** | **survived** | gap — now closed |
| preview source chars to 1 | **survived** | **survived** | gap — now closed |

Two further gaps were found the same way and closed: deleting the evidence
filter left the whole suite green, because the nonsense-query tests are
actually satisfied by the confidence gate below it; and the vector backlog an
agent is told about could read zero while nothing was embedded.

The three "gap" rows were the dangerous ones. The resume-cursor overlap in
particular loses messages silently: the cursor lands on the newest timestamp
read, and any message sharing that timestamp is never yielded again.

## Known and accepted

- **Ranking numbers are the eval's; ranking behaviour is not.** A weight is a
  quality decision swept against a corpus, so pinning 0.5 in a unit test would
  fight the next sweep — the eval owns the values, and you should still run
  `npm run test:eval` when touching `handoff/ranking.ts`.
  `tests/handoff/ranking-contract.test.ts` covers the separate question of
  whether the behaviour exists at all: corroboration helps, the tie-break only
  breaks ties, windows overlap, one session cannot fill the answer. Those
  assert shape rather than value, so a re-sweep passes and a deletion does not.
  Verified against four mutations that previously only the eval caught.
- **The embedding model is disabled in most of the suite.** Several vitest
  workers each loading a ~100MB ONNX model exhausted memory and produced
  failures in unrelated tests. `tests/setup.ts` sets
  `XTCTX_DISABLE_EMBEDDINGS=1`; search degrades to keyword without vectors, so
  a test not asserting embeddings loses nothing. The real provider is still
  exercised: `tests/handoff/embeddings.test.ts` builds it directly and runs in
  the default suite, and the eval embeds a whole corpus.
- **`toFtsQuery` escapes a quote that cannot reach it.** The term pattern does
  not admit `"`, so the escaping is unreachable belt-and-braces. Kept, and
  pinned by a test that says so, rather than removed.

## The literal search route

`mode: "literal"` reads the transcript stores instead of the index, which makes
it the one retrieval path that could widen the project boundary — a grep over a
store returns every project's conversations. It does not read files: it streams
what each scraper yields, attribution already applied, so the boundary is
enforced in one place rather than two. `tests/handoff/literal-search.test.ts`
opens on that case for exactly that reason.

Its budget is its own, not the refresh budget. Sharing them was a real bug
caught while writing these tests: `refreshBudgetMs: 0` means "do not wait for a
scan", and reusing it gave the literal pass no time at all, so it returned
nothing and called itself complete.

## Adding a test

Ask which layer would have caught the defect, not which is easiest to write.
Then break the code and confirm the new test goes red — a test that passes
against the bug it was written for is worse than no test, because it is
counted as coverage.
