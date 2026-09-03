import { createProjectServices } from "../runtime/services.js";

interface ScanOptions {
  projectPath?: string;
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
  } finally {
    await services.sessions.close().catch(() => {});
  }
}
