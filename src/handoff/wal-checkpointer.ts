import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { Database as DatabaseHandle } from "better-sqlite3";

/**
 * How often a scan folds the write-ahead log back into the database. It
 * stands in for SQLite's own checkpoint every 1,000 pages, which a scan turns
 * off; without it the log would hold everything the scan wrote.
 *
 * Short, because `close` waits for a checkpoint already running. Closing
 * mid-scan took up to 563ms over 30 runs at 250ms (95th percentile 130ms),
 * and up to 328ms at 100ms (95th percentile 44ms), against 184ms and 46ms
 * over 90 runs before checkpoints moved here.
 */
const CHECKPOINT_INTERVAL_MS = 100;

/**
 * Once per process: a worker that cannot start fails the same way on every
 * scan, and a server scans on most tool calls.
 */
let workerFailureReported = false;

function reportWorkerFailure(error: unknown): void {
  if (workerFailureReported) {
    return;
  }
  workerFailureReported = true;
  process.stderr.write(
    `xtctx: the scan's checkpoint worker failed ` +
      `(${error instanceof Error ? error.message : String(error)}); ` +
      `scans checkpoint on the main thread instead, which can hold up tool calls.\n`,
  );
}

/** One row of `PRAGMA wal_checkpoint`: pages in the log, and how many are now in the database. */
export interface CheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

/**
 * Runs in a worker thread, with its own connection: answers each message with
 * a checkpoint's result, and closes on "stop". CommonJS because an `eval`
 * worker is one; the driver is passed in by path because a worker's `require`
 * resolves from the working directory, which for an installed CLI is the
 * user's project, not this package.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.driver);
const db = new Database(workerData.dbPath, { fileMustExist: true });
parentPort.on("message", (message) => {
  let result = null;
  try {
    result = db.pragma("wal_checkpoint(PASSIVE)")[0];
  } catch {
    // Another connection's checkpoint was running; the next one catches up.
  }
  parentPort.postMessage(result);
  if (message === "stop") {
    db.close();
    parentPort.close();
  }
});
`;

/**
 * Keeps a scan's disk flushes off the thread that answers tool calls.
 *
 * The scan yields every 20ms, but a commit cannot be interrupted, and the
 * commit that takes the write-ahead log past 1,000 pages also checkpoints: it
 * copies the log into the database and flushes both to disk. With two other
 * processes committing to the same disk, one commit took 4,445ms of a 6,515ms
 * scan; that is the event loop, and every tool call queued behind it, waiting
 * on the disk.
 *
 * While a scan runs, this turns SQLite's automatic checkpoint off, and a
 * worker thread with its own connection checkpoints instead, so the flushes
 * happen on its thread. The scan awaits each one at a yield point rather than
 * writing alongside it: a checkpoint left to run on a timer while the scan
 * kept committing held those commits up instead, by up to 417ms each with two
 * scans running at once.
 *
 * Commits themselves do not flush: better-sqlite3 builds SQLite with
 * `synchronous = NORMAL` for write-ahead-log databases, so a commit writes the
 * log and returns, and a power cut can lose commits made since the last
 * flush. Within the database that is harmless, because the log is replayed in
 * order, so what survives is always an earlier state of the index. Outside it
 * is not: a cursor is a separate file, and one that survived the commits it
 * vouches for would skip those messages for good. `durable` flushes the log
 * before a cursor is saved, off this thread.
 */
export class WalCheckpointer {
  private lastCheckpointAt = Date.now();
  private pending: ((result: CheckpointResult | null) => void) | null = null;
  /** Set once the worker has exited, after which nothing will answer. */
  private exitedAlready = false;
  /** Set by `abandon`: nothing waits on the worker from then on. */
  private abandoned = false;

  private constructor(
    private readonly db: DatabaseHandle,
    private readonly walPath: string,
    private readonly worker: Worker | null,
    private readonly exited: Promise<void>,
    private readonly restoreAutocheckpoint: number,
  ) {
    worker?.on("message", (result: CheckpointResult | null) => this.settle(result));
  }

  static start(db: DatabaseHandle, dbPath: string): WalCheckpointer {
    const restore = db.pragma("wal_autocheckpoint", { simple: true }) as number;
    // Nothing to flush for an in-memory index, and no file for a worker to open.
    if (db.memory) {
      return new WalCheckpointer(db, "", null, Promise.resolve(), restore);
    }

    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        driver: createRequire(import.meta.url).resolve("better-sqlite3"),
        dbPath,
      },
    });
    // A worker that fails to start answers nothing; the log then waits for
    // `stop` to hand checkpointing back to this connection. Slower, never
    // wrong, so the scan carries on; but it is the stall this class exists to
    // prevent, so it is said once, on stderr (stdout is the MCP channel).
    worker.on("error", (error) => reportWorkerFailure(error));
    // Held open only while the scan waits on an answer; see `request`.
    worker.unref();
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));

    db.pragma("wal_autocheckpoint = 0");
    const checkpointer = new WalCheckpointer(db, `${dbPath}-wal`, worker, exited, restore);
    void exited.then(() => {
      checkpointer.exitedAlready = true;
      checkpointer.settle(null);
    });
    return checkpointer;
  }

  /** Checkpoint on the worker if the last one was `CHECKPOINT_INTERVAL_MS` ago. */
  async checkpointIfDue(): Promise<void> {
    if (Date.now() - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) {
      return;
    }
    await this.request("checkpoint");
    this.lastCheckpointAt = Date.now();
  }

  /**
   * Flush what has been committed so far to disk, on the thread pool.
   *
   * Flushing the log is enough: a checkpoint flushes the database before the
   * log is ever reused, so a commit is either in the flushed log or already
   * in the flushed database.
   */
  async durable(): Promise<void> {
    if (!this.worker) {
      return;
    }
    let handle;
    try {
      handle = await open(this.walPath, "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // No log means everything is in the database file, which the
        // checkpoint that removed the log flushed.
        return;
      }
      throw error;
    }
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Checkpoint once more on the worker, close it, and turn the automatic
   * checkpoint back on.
   * Resolves with that last checkpoint's result, or null when the worker did
   * not run one: it failed to start, or there is no file to checkpoint.
   */
  async stop(): Promise<CheckpointResult | null> {
    let result: CheckpointResult | null = null;
    if (!this.abandoned) {
      result = await this.request("stop");
    }
    // Checked again: `abandon` may have answered the request above, and the
    // worker then exits only when its checkpoint returns.
    if (!this.abandoned) {
      await this.exited;
    }
    try {
      this.db.pragma(`wal_autocheckpoint = ${this.restoreAutocheckpoint}`);
    } catch {
      // Closed underneath: nothing left to restore it on.
    }
    return result;
  }

  /**
   * Stop waiting on the worker, for an index that is closing.
   *
   * `stop` runs one more checkpoint and waits for the worker to exit, and a
   * checkpoint already running cannot be cut short: it is native code, and
   * `terminate` takes effect only when it returns. On a busy disk that is
   * seconds, and a server told to shut down has a two-second grace window.
   * Closing does not need the checkpoint, because the closing connection
   * truncates the log itself when it can (`truncateWal`), and leaves it for
   * the next server when it cannot.
   *
   * So this answers the scan's pending request now, with no result, and lets
   * the worker go: terminated, and unreferenced so it does not hold the
   * process open. A checkpoint cut off by the process exiting is a crash as
   * far as SQLite is concerned, which the log is built to survive.
   */
  abandon(): void {
    if (!this.worker || this.abandoned) {
      return;
    }
    this.abandoned = true;
    this.worker.unref();
    void this.worker.terminate();
    this.settle(null);
  }

  /** One request at a time: the scan awaits each before it writes again. */
  private request(message: "checkpoint" | "stop"): Promise<CheckpointResult | null> {
    if (!this.worker || this.exitedAlready || this.abandoned) {
      return Promise.resolve(null);
    }
    const worker = this.worker;
    // An unreferenced worker does not keep the process alive, so a scan
    // awaiting only its answer let a one-off command exit mid-scan. After
    // "stop" it stays referenced until it has exited, which `stop` awaits.
    worker.ref();
    return new Promise((resolve) => {
      this.pending = (result) => {
        if (message !== "stop" && !this.abandoned) {
          worker.unref();
        }
        resolve(result);
      };
      worker.postMessage(message);
    });
  }

  private settle(result: CheckpointResult | null): void {
    const pending = this.pending;
    this.pending = null;
    pending?.(result);
  }
}
