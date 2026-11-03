/**
 * PostgreSQL schema migrations (lib/database/postgres/migrations). Separate from app deployment: run it on purpose,
 * after a backup, before deploying code that needs the new schema (docs/postgresql-migration.md).
 *
 *   npx tsx scripts/pg-migrate.ts           # status only: what is applied and what is pending (read-only)
 *   npx tsx scripts/pg-migrate.ts --apply   # apply pending migrations
 *
 * Requires DATABASE_PROVIDER=supabase and DATABASE_URL from the environment (never committed). The connection string
 * is never printed.
 */
import { readEnv } from "@/lib/config/env";
import { applyMigrations, migrationStatus, type MigrationConnection } from "@/lib/database/postgres/migrator";
import { createPgPool } from "@/lib/database/sql/postgres-executor";
import { postgresConfig } from "@/lib/database/sql/select-executor";

// tsx runs these scripts as CommonJS (no top-level await), so the work happens in main().
async function main(): Promise<void> {
  const env = readEnv();
  const apply = process.argv.includes("--apply");
  if (env.DATABASE_PROVIDER !== "supabase") {
    console.error("Set DATABASE_PROVIDER=supabase (and DATABASE_URL) in the environment.");
    process.exit(1);
  }
  let config: ReturnType<typeof postgresConfig>;
  try {
    config = postgresConfig(env); // validates DATABASE_URL and the pool settings without echoing them
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // One connection (BEGIN/COMMIT must reach the same session); schema changes may take longer than app queries.
  const pool = createPgPool(config.url, { ...config.options, max: 1, queryTimeoutMillis: Math.max(config.options.queryTimeoutMillis ?? 0, 120_000) });
  const client = await pool.connect();
  const conn: MigrationConnection = { query: async (text, values) => ({ rows: (await client.query(text, values)).rows }) };
  try {
    const before = await migrationStatus(conn);
    console.log(`Applied: ${before.applied.map((m) => `${m.version}_${m.name}`).join(", ") || "none"}`);
    console.log(`Pending: ${before.pending.map((m) => `${m.version}_${m.name}`).join(", ") || "none"}`);
    if (apply && before.pending.length) {
      const done = await applyMigrations(conn);
      console.log(`Applied now: ${done.join(", ") || "none (another runner applied them)"}`);
    } else if (!apply && before.pending.length) {
      console.log("Status only. Re-run with --apply to apply the pending migrations.");
    }
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
