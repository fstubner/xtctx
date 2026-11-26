import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPool, runMigrations } from "./db/pool.js";
import { createEmbedderFromEnv } from "./embedder.js";
import { drainEmbeddingQueue, runWorkerLoop } from "./worker-loop.js";

function resolveMigrationsDir(): string {
  for (const candidate of ["./migrations/", "../migrations/"]) {
    const p = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(p)) return p;
  }
  return fileURLToPath(new URL("../migrations/", import.meta.url));
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const embedder = createEmbedderFromEnv(process.env);
  if (!embedder) {
    console.log(JSON.stringify({ event: "worker_disabled", reason: "EMBEDDING_PROVIDER=none" }));
    return;
  }

  const pool = createPool(databaseUrl);
  await runMigrations(pool, resolveMigrationsDir(), process.env.DATABASE_APP_ROLE?.trim() || undefined);

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => ac.abort());
  }

  try {
    if (process.argv.slice(2).includes("--once")) {
      const processed = await drainEmbeddingQueue({ pool, embedder, signal: ac.signal });
      console.log(JSON.stringify({ event: "worker_once_complete", provider: embedder.provider, model: embedder.model, processed }));
      return;
    }
    const pollMsRaw = Number(process.env.EMBEDDING_POLL_MS ?? "2000");
    const pollMs = Number.isFinite(pollMsRaw) && pollMsRaw > 0 ? pollMsRaw : 2000;
    console.log(JSON.stringify({ event: "worker_started", provider: embedder.provider, model: embedder.model }));

    await runWorkerLoop({ pool, embedder, pollMs, signal: ac.signal });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "worker_fatal", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
