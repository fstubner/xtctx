import { createProjectServices } from "../runtime/services.js";
import type { SessionService } from "../handoff/types.js";
import { formatDuration } from "../utils/duration.js";

interface ScanOptions {
  projectPath?: string;
  /**
   * Also embed every window the scan leaves without a vector.
   *
   * Off by default, and the default is the important half: the session-start
   * hook launches this command detached, so draining here unconditionally
   * would start hours of embedding every time an agent opens a large project.
   */
  embed?: boolean;
}

/**
 * Scan every enabled transcript store into this project's index, then exit.
 *
 * The MCP server scans on demand and answers within a budget, and the
 * session-start hook reads without scanning at all. Between them, a project
 * that has not been asked anything yet has an empty index — so the first
 * session after another tool's work starts cold. This is the piece that
 * fills that gap: the hook launches it detached, and it runs to completion
 * with nobody waiting on it.
 *
 * Also usable by hand, which is why it is a public command and not an
 * internal flag: "warm the index" is a reasonable thing to want to do.
 */
export async function runScan(options: ScanOptions = {}): Promise<void> {
  const services = await createProjectServices(options.projectPath);
  const startedAt = Date.now();

  try {
    // The same refusals the MCP server makes, for the same reasons: nobody
    // opted this directory in, or the file that says which stores may be read
    // cannot be read. Scanning anyway would either write an index nowhere
    // asked for one, or read stores the user may have switched off.
    if (!services.config.present) {
      process.stderr.write(
        `${services.projectRoot} is not configured for xtctx — nothing to scan. Run \`xtctx setup\` first.\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (services.config.error) {
      process.stderr.write(
        `${services.configPath} could not be read (${services.config.error}); nothing was scanned.\n`,
      );
      process.exitCode = 1;
      return;
    }

    // Any read starts the scan; the budget only bounds how long the read
    // waits. Settling afterwards is what makes this a complete scan rather
    // than a bounded one.
    await services.sessions.listRecentSessions(1);
    await services.sessions.whenScanSettled?.();

    const status = await services.sessions.getStatus();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(
      `Scanned ${status.sessions} session${status.sessions === 1 ? "" : "s"} into ${status.db_path} in ${seconds}s\n`,
    );

    if (options.embed) {
      await embedBacklog(services.sessions);
    }
  } finally {
    await services.sessions.close().catch(() => {});
  }
}

/**
 * Work the embedding backlog down to nothing, reporting as it goes.
 *
 * This runs for hours on a large history — a 9,232-window project needs about
 * two — so it prints progress rather than going quiet. A command with no
 * output for that long is indistinguishable from a hung one, and the person
 * running it has no other way to tell.
 *
 * Every batch commits before the next starts, so interrupting this loses only
 * the batch in flight; running it again resumes from where it stopped.
 */
async function embedBacklog(sessions: SessionService): Promise<void> {
  if (!sessions.embedBacklog) {
    process.stderr.write("This index cannot embed on demand; nothing was embedded.\n");
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  let lastReportAt = 0;
  const remaining = await sessions.embedBacklog((embedded, total) => {
    // Throttled: a batch is eight windows and commits every few seconds, so
    // reporting each one buries the result in thousands of lines.
    const now = Date.now();
    if (embedded < total && now - lastReportAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    lastReportAt = now;
    const perUnit = (now - startedAt) / embedded;
    const eta = formatDuration(Math.round((total - embedded) * perUnit));
    process.stdout.write(
      `  embedded ${embedded}/${total} windows${eta ? `, about ${eta} left` : ""}\n`,
    );
  });

  const took = formatDuration(Date.now() - startedAt);
  if (remaining > 0) {
    // Not expected: the pass is uncapped. Saying so beats reporting a
    // completion that did not happen.
    process.stdout.write(`Embedding stopped with ${remaining} windows outstanding${took ? ` after ${took}` : ""}.\n`);
    return;
  }
  process.stdout.write(`Embedding complete${took ? ` in ${took}` : ""}.\n`);
}

/** How often the embedding pass reports, in ms. */
const PROGRESS_INTERVAL_MS = 30_000;
