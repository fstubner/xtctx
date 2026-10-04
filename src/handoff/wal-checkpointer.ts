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
 * The scan yields every 20ms, but a commit cannot be interrupted, and at the
 * default `synchronous = FULL` every commit flushes the write-ahead log to
 * disk, while the commit that crosses 1,000 pages also checkpoints: it copies
 * the log into the database and flushes both. With two other processes
 * committing to the same disk, one commit took 4,445ms of a 6,515ms scan;
 * that is the event loop, and every tool call queued behind it, waiting on
 * the disk.
 *
 * While a scan runs, this sets `synchronous = NORMAL`, under which a commit in
 * write-ahead-log mode writes the log without flushing it, and turns SQLite's
 * automatic checkpoint off. A worker thread with its own connection
 * checkpoints instead, so the flushes happen on its thread, and the scan
 * awaits each one at a yield point rather than writing alongside it: a
 * checkpoint left to run on a timer while the scan kept committing held
 * those commits up instead, by up to 417ms each with two scans running at
 * once.
 *
 * `NORMAL` costs durability, not integrity: a process that is killed loses
 * nothing, because the log is written before each commit returns, but a power
 * cut can lose commits made since the last flush. Within the database that is
 * harmless, because the log is replayed in order, so what survives is always an
 * earlier state of the index. Outside it is not: a cursor is a separate file,
 * and one that survived the commits it vouches for would skip those messages
 * for good. `durable` flushes the log first, off this thread.
 */
export class WalCheckpointer {
  private lastCheckpointAt = Date.now();
  private pending: ((result: CheckpointResult | null) => void) | null = null;
  /** Set once the worker has exited, after which nothing will answer. */
  private exitedAlready = false;

  private constructor(
    private readonly db: DatabaseHandle,
    private readonly walPath: string,
    private readonly worker: Worker | null,
    private readonly exited: Promise<void>,
    private readonly restore: { synchronous: number; autocheckpoint: number },
  ) {
    worker?.on("message", (result: CheckpointResult | null) => this.settle(result));
  }

  static start(db: DatabaseHandle, dbPath: string): WalCheckpointer {
    const restore = {
      synchronous: db.pragma("synchronous", { simple: true }) as number,
      autocheckpoint: db.pragma("wal_autocheckpoint", { simple: true }) as number,
    };
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
    // `stop` to hand checkpointing back to this connection. Slower, never wrong.
    worker.on("error", () => {});
    // Held open only while the scan waits on an answer; see `request`.
    worker.unref();
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));

    db.pragma("synchronous = NORMAL");
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
   * Checkpoint once more on the worker, close it, and restore both settings.
   * Resolves with that last checkpoint's result, or null when the worker did
   * not run one: it failed to start, or there is no file to checkpoint.
   */
  async stop(): Promise<CheckpointResult | null> {
    const result = await this.request("stop");
    await this.exited;
    try {
      this.db.pragma(`synchronous = ${this.restore.synchronous}`);
      this.db.pragma(`wal_autocheckpoint = ${this.restore.autocheckpoint}`);
    } catch {
      // Closed underneath: nothing left to restore them on.
    }
    return result;
  }

  /** One request at a time: the scan awaits each before it writes again. */
  private request(message: "checkpoint" | "stop"): Promise<CheckpointResult | null> {
    if (!this.worker || this.exitedAlready) {
      return Promise.resolve(null);
    }
    const worker = this.worker;
    // An unreferenced worker does not keep the process alive, so a scan
    // awaiting only its answer let a one-off command exit mid-scan. After
    // "stop" it stays referenced until it has exited, which `stop` awaits.
    worker.ref();
    return new Promise((resolve) => {
      this.pending = (result) => {
        if (message !== "stop") {
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
