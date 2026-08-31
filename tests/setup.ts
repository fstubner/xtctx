/**
 * Budgets that describe production latency, not correctness, turned down for
 * the suite.
 *
 * Both defaults are sized for a single process doing real work for a waiting
 * user. A test run is neither: vitest fans out across workers, and every one
 * of them paying a model load or a lock wait that the test is not asserting
 * turns coverage into contention. That showed up as intermittent failures in
 * whichever suite happened to be starved — and as run-to-run differences in
 * how many tests even completed.
 *
 * Anything actually asserting these budgets sets its own, which still works:
 * an explicit constructor option beats the environment.
 */

// The scan's wait for the embedding model. Production waits so that
// vectorising happens at all in a short-lived process; a test that is not
// about embeddings should never pay for a 100MB model load.
process.env.XTCTX_EMBEDDING_WARM_MS ??= "0";

// The drift log's lock wait. Production is sized for an MCP tool call, where a
// stalled flush blocks a user; under a loaded suite that budget measures the
// machine rather than the lock.
process.env.XTCTX_LOCK_WAIT_MS ??= "60000";

// The embedding model. Several vitest workers each initialising a ~100MB ONNX
// model exhausted memory: ONNX raised `bad allocation`, the worker died, and
// the visible symptom was an unrelated test failing — a different one each
// run — with the completed-test count varying between runs. Search degrades to
// keyword without vectors, so a suite that is not asserting embeddings loses
// nothing. `tests/handoff/embeddings.test.ts` constructs the real provider
// directly and is unaffected.
process.env.XTCTX_DISABLE_EMBEDDINGS ??= "1";
