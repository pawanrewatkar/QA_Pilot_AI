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
import pg from "pg";
import { readEnv } from "@/lib/config/env";
import { applyMigrations, migrationStatus, type MigrationConnection } from "@/lib/database/postgres/migrator";

const env = readEnv();
const apply = process.argv.includes("--apply");
if (env.DATABASE_PROVIDER !== "supabase" || !env.DATABASE_URL || !/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
  console.error("Set DATABASE_PROVIDER=supabase and DATABASE_URL (postgres:// or postgresql://) in the environment.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
pool.on("error", (error: Error & { code?: string }) => console.error(`PostgreSQL connection error (${error.code ?? error.name})`));
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
