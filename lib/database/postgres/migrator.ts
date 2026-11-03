import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Versioned PostgreSQL schema migrations (lib/database/postgres/migrations/NNNN_name.sql).
 *
 * - Applied migrations are recorded in `qa_pilot_migrations` with a checksum of the file. Editing an applied file,
 *   or a database that has migrations this code does not know, stops the run before anything is applied.
 * - Each pending migration runs in its own transaction together with its tracking row: it is applied completely or
 *   not at all. A failure stops the run; earlier migrations stay applied.
 * - A transaction-scoped advisory lock serializes concurrent runners (it also works through a transaction-mode
 *   connection pooler, unlike a session lock); a runner that finds the version already recorded skips it.
 *
 * Runs only when invoked explicitly (scripts/pg-migrate.ts); the app never migrates PostgreSQL on its own.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

/**
 * One dedicated database connection (not a pool: BEGIN/COMMIT must reach the same session). `query` without
 * values must accept several statements (the `pg` client does, using the simple query protocol).
 */
export interface MigrationConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export const MIGRATIONS_TABLE = "qa_pilot_migrations";
/** Arbitrary constant identifying this app's migration lock. */
const LOCK_KEY = 72_150_001;
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export const DEFAULT_MIGRATIONS_DIR = path.join(import.meta.dirname, "migrations");

/** Line endings are normalized so a checkout with CRLF has the same checksum as one with LF. */
export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** The migration files, in version order. Versions must start at 1 and have no gaps or duplicates. */
export function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const migrations = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const m = FILE.exec(f);
      if (!m) throw new MigrationError(`Unexpected migration file name: ${f} (expected NNNN_name.sql)`);
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      return { version: Number(m[1]), name: m[2], sql, checksum: checksum(sql) };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`Migration versions must be 1..n without gaps; found ${m.version} at position ${i + 1}`);
  });
  return migrations;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

async function applied(conn: MigrationConnection): Promise<AppliedRow[]> {
  const exists = (await conn.query("SELECT to_regclass($1) IS NOT NULL AS present", [MIGRATIONS_TABLE])).rows[0]?.present;
  if (!exists) return [];
  return (await conn.query(`SELECT version, name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`, [])).rows.map((r) => ({
    version: Number(r.version),
    name: String(r.name),
    checksum: String(r.checksum),
    applied_at: String(r.applied_at),
  }));
}

/** Applied rows must match the files exactly; otherwise nothing may be applied. */
function verify(rows: AppliedRow[], migrations: Migration[]) {
  for (const row of rows) {
    const file = migrations.find((m) => m.version === row.version);
    if (!file) throw new MigrationError(`The database has migration ${row.version} (${row.name}), which this code does not have. Deploy matching code first.`);
    if (file.checksum !== row.checksum) throw new MigrationError(`Migration ${row.version} (${row.name}) was changed after it was applied (checksum mismatch). Add a new migration instead.`);
  }
}

export interface MigrationStatus {
  applied: AppliedRow[];
  pending: { version: number; name: string }[];
}

/** Read-only: what is applied and what would be applied. Throws on a checksum mismatch or unknown migration. */
export async function migrationStatus(conn: MigrationConnection, migrations = loadMigrations()): Promise<MigrationStatus> {
  const rows = await applied(conn);
  verify(rows, migrations);
  const done = new Set(rows.map((r) => r.version));
  return { applied: rows, pending: migrations.filter((m) => !done.has(m.version)).map(({ version, name }) => ({ version, name })) };
}

async function inTransaction<T>(conn: MigrationConnection, fn: () => Promise<T>): Promise<T> {
  await conn.query("BEGIN");
  try {
    await conn.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    const value = await fn();
    await conn.query("COMMIT");
    return value;
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** Applies every pending migration in order. Returns the versions applied by this run. */
export async function applyMigrations(conn: MigrationConnection, migrations = loadMigrations()): Promise<number[]> {
  await inTransaction(conn, () =>
    conn.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
       ALTER TABLE ${MIGRATIONS_TABLE} ENABLE ROW LEVEL SECURITY;`,
    ),
  );
  verify(await applied(conn), migrations);
  const done: number[] = [];
  for (const m of migrations) {
    try {
      const ran = await inTransaction(conn, async () => {
        // Re-checked under the lock: another runner may have applied it meanwhile.
        if ((await conn.query(`SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE version = $1`, [m.version])).rows.length) return false;
        await conn.query(m.sql);
        await conn.query(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)`, [m.version, m.name, m.checksum, new Date().toISOString()]);
        return true;
      });
      if (ran) done.push(m.version);
    } catch (error) {
      throw new MigrationError(`Migration ${m.version} (${m.name}) failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return done;
}
