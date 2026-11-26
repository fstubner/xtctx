import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import type { CloudContext } from "../types.js";

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

const TENANT_TABLES = [
  "devices",
  "sessions",
  "session_projects",
  "messages",
  "message_chunks",
  "embedding_jobs",
  "uploads",
  "source_coverage",
  "coverage_evidence",
  "subscriptions",
] as const;

export function assertSqlIdentifier(value: string, label: string): void {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new Error(`Invalid SQL identifier for ${label}: ${value}`);
  }
}

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/**
 * Apply ordered `.sql` migrations inside per-migration transactions.
 * When `appRole` is configured, grants least-privilege access on tenant tables
 * and sequences in the active schema so `withUserDb` can enforce RLS via `SET LOCAL ROLE`.
 */
export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
  appRole?: string,
): Promise<void> {
  if (appRole) assertSqlIdentifier(appRole, "appRole");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    // Serialize DDL across simultaneous API and worker startup.
    await client.query("SELECT pg_advisory_lock(789123456)");
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      for (const file of files) {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM schema_migrations WHERE id = $1",
          [file],
        );
        if (existing.rowCount && existing.rowCount > 0) continue;

        const sql = readFileSync(join(migrationsDir, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        }
      }

      if (appRole) {
        const schemaRes = await client.query<{ schema: string }>("SELECT current_schema() AS schema");
        const schema = schemaRes.rows[0]?.schema ?? "public";
        assertSqlIdentifier(schema, "schema");
        await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${appRole}"`);
        const tableList = TENANT_TABLES.map((t) => `"${schema}"."${t}"`).join(", ");
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableList} TO "${appRole}"`);
        await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${appRole}"`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(789123456)").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * Execute an authenticated user query inside a transaction with RLS bound to `userId`.
 * When `ctx.appRole` is set, switches to the NOBYPASSRLS application role for the duration
 * of the transaction so Postgres enforces row-level policies unconditionally.
 */
export async function withUserDb<T>(
  ctx: Pick<CloudContext, "pool" | "appRole">,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!userId) throw new Error("withUserDb requires a non-empty userId");
  const client = await ctx.pool.connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    if (ctx.appRole) {
      assertSqlIdentifier(ctx.appRole, "appRole");
      await client.query(`SET LOCAL ROLE "${ctx.appRole}"`);
    }
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroy = true;
    }
    throw err;
  } finally {
    client.release(destroy);
  }
}

/**
 * Execute a system transaction (account creation, OAuth grant exchange, Stripe webhooks,
 * embedding worker, or account deletion) using the table-owner pool connection.
 */
export async function withSystemDb<T>(
  ctx: Pick<CloudContext, "pool">,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ctx.pool.connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroy = true;
    }
    throw err;
  } finally {
    client.release(destroy);
  }
}
