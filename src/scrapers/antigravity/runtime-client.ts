import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { isRecord, toDate } from "../base.js";
import {
  type HandledStepTally,
  extractWorkspaceUris,
  parseAntigravityRuntimeSteps,
  reportHandledStepRenames,
  toPositiveInteger,
  toStringValue,
} from "./parse.js";
import { shouldFetchTrajectory } from "./project-match.js";
import {
  type AntigravityRuntimeClient,
  type AntigravityRuntimeConversation,
  type AntigravityRuntimeListing,
  warnDrift,
} from "./shared.js";
import { listConversationFileIds } from "./store.js";

const execFileAsync = promisify(execFile);
const LANGUAGE_SERVER_SERVICE = "exa.language_server_pb.LanguageServerService";

interface AntigravityEndpoint {
  port: number;
  csrf: string;
  pid: number;
}

interface AntigravityProcess {
  pid: number;
  csrf: string;
  commandLine: string;
}

export class AntigravityLanguageServerClient implements AntigravityRuntimeClient {
  constructor(private readonly projectRoot?: string) {}

  async listConversations(conversationsDir: string): Promise<AntigravityRuntimeListing> {
    if (process.env.XTCTX_DISABLE_ANTIGRAVITY_RUNTIME === "1") {
      // The language server is a machine-global service: there is exactly one
      // per install, and nothing in its arguments ties it to the transcript
      // directory this reader was pointed at. So a test that sandboxes `HOME`
      // and seeds a synthetic store still reached the real one, and
      // `verify:release` failed on any machine with Antigravity open. This is
      // the only way to isolate it, and it exists for that.
      return { conversations: [] };
    }

    const { endpoints, processesFound } = await discoverLanguageServerEndpoints();
    if (endpoints.length === 0) {
      const degradation = describeUnreachableServer(processesFound);
      return degradation ? { conversations: [], degradation } : { conversations: [] };
    }

    // Answering endpoints exist, so from here on an empty result means this
    // scan failed to read transcripts that are there — a different thing
    // entirely, and the one that used to be silent.
    const handledTally: HandledStepTally = new Map();
    let unanswered = 0;
    let unfetched = 0;

    const bySession = new Map<string, {
      endpoint: AntigravityEndpoint;
      summary: Record<string, unknown>;
    }>();

    for (const endpoint of endpoints) {
      const response = await callLanguageServer(endpoint, "GetAllCascadeTrajectories", {}, 5_000);
      if (response === null) {
        // The endpoint answered during discovery and has stopped answering
        // now, so its sessions are missing from this listing.
        unanswered += 1;
      }
      const summaries = isRecord(response?.trajectorySummaries)
        ? response.trajectorySummaries
        : {};
      for (const [sessionId, summary] of Object.entries(summaries)) {
        if (!isRecord(summary) || bySession.has(sessionId)) {
          continue;
        }
        bySession.set(sessionId, { endpoint, summary });
      }
    }

    const defaultEndpoint = endpoints[0];
    for (const sessionId of await listConversationFileIds(conversationsDir)) {
      if (!bySession.has(sessionId)) {
        bySession.set(sessionId, {
          endpoint: defaultEndpoint,
          summary: {
            summary: `[on-disk] ${sessionId.slice(0, 8)}`,
            stepCount: 1000,
          },
        });
      }
    }

    const worthFetching = [...bySession.entries()].filter(([, entry]) =>
      shouldFetchTrajectory(entry.summary, this.projectRoot, dirname(conversationsDir)),
    );

    // Sessions Antigravity records no workspace for still have to be fetched
    // to find out whose they are, and that is most of them. Fetching them one
    // after another made the scan as slow as the sum of every round trip, so
    // they go out in a small pool instead — same requests, same results, less
    // waiting. The pool is deliberately modest: this is someone's editor
    // answering on localhost, not a service built to be hammered.
    const fetched = await mapWithConcurrency<
      (typeof worthFetching)[number],
      AntigravityRuntimeConversation
    >(worthFetching, 6, async ([sessionId, entry]) => {
      // mapWithConcurrency turns every throw in here into a null result, and
      // `unfetched` was only incremented on an explicit null *response*. So
      // anything throwing after a successful fetch — a parse failure, an
      // unexpected shape — produced a healthy-looking empty scrape with the
      // cursor advanced, which is exactly what the degradation field exists to
      // prevent. Counted here, where the throw is still visible.
      try {
      const stepCount = toPositiveInteger(entry.summary.stepCount) ?? 1000;
      const response = await callLanguageServer(
        entry.endpoint,
        "GetCascadeTrajectorySteps",
        { cascadeId: sessionId, startIndex: 0, endIndex: stepCount + 10 },
        30_000,
      );
      let steps: unknown[] = [];
      if (response === null) {
        // Timed out or errored. The transcript is still there; this scan just
        // did not get it, which must not be mistaken for an empty session.
        unfetched += 1;
      } else if (Array.isArray(response.steps)) {
        steps = response.steps;
      } else if (Array.isArray(response.messages)) {
        steps = response.messages;
      } else {
        // The server answered, but with neither field this reader knows. Every
        // message in the session is dropped, and without this it is dropped in
        // silence — indistinguishable from a session that is simply empty.
        warnDrift(
          `antigravity-ls:${sessionId}`,
          `trajectory response has neither 'steps' nor 'messages' (keys: ${Object.keys(response).sort().join(", ") || "none"})`,
        );
      }
      const messages = parseAntigravityRuntimeSteps(sessionId, steps, entry.summary, handledTally);
      if (messages.length === 0) {
        return null;
      }

      return {
        sessionId,
        title: toStringValue(entry.summary.summary),
        createdAt: toDate(entry.summary.createdTime),
        workspaces: extractWorkspaceUris(entry.summary),
        messages,
      };
      } catch (err) {
        unfetched += 1;
        warnDrift(
          `antigravity-ls:${entry.endpoint}`,
          `trajectory read failed for ${sessionId}: ${(err as Error).message}`,
        );
        throw err;
      }
    });

    const conversations = fetched.filter(
      (entry): entry is AntigravityRuntimeConversation => entry !== null,
    );

    reportHandledStepRenames(handledTally, `antigravity-ls:${conversationsDir}`);

    const reasons: string[] = [];
    if (unanswered > 0) {
      reasons.push(`${unanswered} of ${endpoints.length} language server endpoints stopped answering`);
    }
    if (unfetched > 0) {
      reasons.push(`${unfetched} of ${worthFetching.length} trajectories could not be fetched`);
    }

    return reasons.length > 0
      ? { conversations, degradation: reasons.join("; ") }
      : { conversations };
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * One failed fetch must not lose the rest of the scan, so a rejection becomes
 * a null for that item rather than taking the whole batch down.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R | null>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index]);
      } catch {
        results[index] = null;
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Endpoints that answered, and how many language server processes were there
 * to answer.
 *
 * The count is what separates "Antigravity is not running" from "Antigravity
 * is running and did not reply in time". Discovery probes each port with a
 * five-second call, and on a loaded machine that call times out — so an empty
 * endpoint list alone was read as "closed", the reader fell back to brain
 * artifacts, and the scan looked healthy while capturing almost nothing. That
 * is the exact case this reporting was added for, and it slipped through the
 * first version of the fix.
 */
interface AntigravityDiscovery {
  endpoints: AntigravityEndpoint[];
  processesFound: number;
}

/**
 * Why no endpoint answered, when that is worth reporting.
 *
 * Undefined means it is not: no language server process exists, so Antigravity
 * is closed, nothing has been lost, and warning would fire on every scan with
 * the app shut. A process that is running and did not answer is the opposite —
 * its transcripts are there and this scan cannot see them.
 *
 * Split out because this one branch is the whole distinction, and getting it
 * wrong is silent by construction: the first version of this fix only checked
 * the fetches and left discovery reading a slow server as a closed one.
 */
export function describeUnreachableServer(processesFound: number): string | undefined {
  return processesFound === 0
    ? undefined
    : `${processesFound} language server process(es) running but none answered discovery`;
}

/**
 * Whether a language server process is Antigravity's.
 *
 * `language_server*` matches Windsurf and Codeium too — the same binary family
 * from the same vendor. Probing theirs wastes a scan and, worse, reports a
 * degradation for an Antigravity that was never running.
 *
 * Antigravity's own process names itself in its arguments
 * (`--override_ide_name antigravity`, `--app_data_dir antigravity`, and an
 * install path ending in `Antigravity`), and the others do not. The store path
 * is deliberately not used: the server's arguments name the install, never the
 * transcript directory, so matching on that found nothing at all.
 */
function isAntigravityLanguageServer(commandLine: string): boolean {
  return commandLine.toLowerCase().includes("antigravity");
}

async function discoverLanguageServerEndpoints(): Promise<AntigravityDiscovery> {
  const processes = (await discoverLanguageServerProcesses()).filter((info) =>
    isAntigravityLanguageServer(info.commandLine),
  );
  const endpoints: AntigravityEndpoint[] = [];
  const seenPorts = new Set<number>();

  for (const processInfo of processes) {
    const ports = await findListeningPorts(processInfo.pid);
    for (const port of ports) {
      if (seenPorts.has(port)) {
        continue;
      }
      const response = await callLanguageServer(
        { port, csrf: processInfo.csrf, pid: processInfo.pid },
        "GetAllCascadeTrajectories",
        {},
        5_000,
      );
      if (response !== null) {
        endpoints.push({ port, csrf: processInfo.csrf, pid: processInfo.pid });
        seenPorts.add(port);
        break;
      }
    }
  }

  return { endpoints, processesFound: processes.length };
}

async function discoverLanguageServerProcesses(): Promise<AntigravityProcess[]> {
  return process.platform === "win32"
    ? discoverWindowsLanguageServerProcesses()
    : discoverPosixLanguageServerProcesses();
}

async function discoverWindowsLanguageServerProcesses(): Promise<AntigravityProcess[]> {
  try {
    const script = [
      "Get-CimInstance Win32_Process",
      "Where-Object { $_.Name -like 'language_server*' }",
      "Select-Object ProcessId, CommandLine",
      "ConvertTo-Json -Compress",
    ].join(" | ");
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
      timeout: 15_000,
    });
    return parseProcessJson(String(stdout));
  } catch {
    return [];
  }
}

async function discoverPosixLanguageServerProcesses(): Promise<AntigravityProcess[]> {
  if (process.platform === "darwin") {
    return discoverMacLanguageServerProcesses();
  }

  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "language_server"], {
      timeout: 5_000,
    });
    const pids = String(stdout)
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0);

    const processes: AntigravityProcess[] = [];
    for (const pid of pids) {
      try {
        const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
        const commandLine = cmdline.replace(/\0/g, " ");
        processes.push({ pid, csrf: extractCsrfToken(commandLine), commandLine });
      } catch {
        // Ignore read failures for exited processes
      }
    }
    return processes;
  } catch {
    return [];
  }
}

async function discoverMacLanguageServerProcesses(): Promise<AntigravityProcess[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "language_server"], {
      timeout: 5_000,
    });
    const processes: AntigravityProcess[] = [];
    for (const pidText of String(stdout).split(/\r?\n/)) {
      const pid = Number(pidText.trim());
      if (!Number.isFinite(pid)) {
        continue;
      }
      try {
        const { stdout: commandLine } = await execFileAsync("ps", ["-p", String(pid), "-o", "args="], {
          timeout: 5_000,
        });
        processes.push({ pid, csrf: extractCsrfToken(String(commandLine)), commandLine: String(commandLine) });
      } catch {
        // Ignore processes that exit between pgrep and ps.
      }
    }
    return processes;
  } catch {
    return [];
  }
}

function parseProcessJson(raw: string): AntigravityProcess[] {
  if (!raw.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter(isRecord)
      .map((row) => {
        const pid = Number(row.ProcessId);
        const commandLine = toStringValue(row.CommandLine) ?? "";
        return Number.isFinite(pid)
          ? { pid, csrf: extractCsrfToken(commandLine), commandLine }
          : null;
      })
      .filter((value): value is AntigravityProcess => value !== null);
  } catch {
    return [];
  }
}

function extractCsrfToken(commandLine: string): string {
  return commandLine.match(/--csrf_token\s+(\S+)/)?.[1] ?? "";
}

async function findListeningPorts(pid: number): Promise<number[]> {
  return process.platform === "win32" ? findWindowsListeningPorts(pid) : findPosixListeningPorts(pid);
}

/**
 * Extract the ports a specific PID is listening on from `netstat -ano`.
 *
 * The PID is the last whitespace-separated column. Matching it with
 * `endsWith` treats PID 2140 as a match for PID 140, which would attribute
 * an unrelated process's port to the language server — and the CSRF token
 * is POSTed to whatever answers there. The column is compared exactly.
 */
export function parseWindowsListeningPorts(netstatOutput: string, pid: number): number[] {
  return netstatOutput
    .split(/\r?\n/)
    .filter((line) => {
      const columns = line.trim().split(/\s+/);
      return columns.includes("LISTENING") && columns[columns.length - 1] === String(pid);
    })
    .map((line) => line.match(/\s(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)\s/)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

/** Extract listening ports from `lsof -Pan -p <pid> -iTCP -sTCP:LISTEN`. */
export function parsePosixListeningPorts(lsofOutput: string): number[] {
  return lsofOutput
    .split(/\r?\n/)
    .map((line) => line.match(/:(\d+)\s+\(LISTEN\)/)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

async function findWindowsListeningPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano"], { timeout: 10_000 });
    return parseWindowsListeningPorts(String(stdout), pid);
  } catch {
    return [];
  }
}

async function findPosixListeningPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-Pan", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"],
      { timeout: 10_000 },
    );
    return parsePosixListeningPorts(String(stdout));
  } catch {
    return [];
  }
}

async function callLanguageServer(
  endpoint: AntigravityEndpoint,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = httpsRequest(
      {
        // Loopback only, and the language server presents a self-signed
        // certificate there is no CA to validate against — so verification is
        // off by necessity, not convenience. The control that matters is
        // sending the CSRF token to the *right* process, which is why the
        // PID column is matched exactly (see parseWindowsListeningPorts).
        hostname: "127.0.0.1",
        port: endpoint.port,
        path: `/${LANGUAGE_SERVER_SERVICE}/${method}`,
        method: "POST",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": endpoint.csrf,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
            resolve(isRecord(parsed) ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

