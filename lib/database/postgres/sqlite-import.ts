import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../local/sqlite-client";
import type { MigrationConnection } from "./migrator";

/**
 * Copies a SQLite database into an empty PostgreSQL database created by the migrations, and proves the copy.
 * Library only: there is deliberately no command that points it at the live SQLite file. Run it against a COPY of
 * the database (see docs/postgresql-migration.md), never the file the app is using.
 *
 * - `preflightSqlite`: problems that would make the import fail or change data, found before touching PostgreSQL.
 * - `importSqliteIntoPostgres`: one transaction (all rows or none), tables in foreign-key order, SQLite rowids kept
 *   in the PostgreSQL rowid columns (so insertion-order tie-breaks are unchanged) and their sequences moved past them.
 * - `validateImport`: per-table row counts and a digest of every row, on both sides.
 */

const SKIP = new Set(["schema_migrations"]); // SQLite's own migration tracking; PostgreSQL has qa_pilot_migrations
const INT4 = 2_147_483_647;

interface Column {
  name: string;
  type: string;
  pk: number;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function columns(db: SqliteDatabase, table: string): Column[] {
  return db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Column[];
}

/** App tables in foreign-key order (parents first). */
export function sqliteTables(db: SqliteDatabase): string[] {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !SKIP.has(n));
  const deps = new Map(names.map((n) => [n, (db.prepare(`PRAGMA foreign_key_list(${quote(n)})`).all() as { table: string }[]).map((f) => f.table).filter((t) => t !== n)]));
  const ordered: string[] = [];
  const pending = new Set(names);
  while (pending.size) {
    const ready = [...pending].find((n) => deps.get(n)!.every((d) => !pending.has(d)));
    if (!ready) throw new Error(`Circular foreign keys among: ${[...pending].join(", ")}`);
    ordered.push(ready);
    pending.delete(ready);
  }
  return ordered;
}

export interface PreflightProblem {
  table: string;
  column?: string;
  rowid?: number;
  problem: string;
}

/**
 * Checks a SQLite database for what PostgreSQL would reject or store differently: integrity, foreign keys that
 * point nowhere, integers outside the 4-byte range, values whose type does not match the column (SQLite allows
 * this), and NUL characters (PostgreSQL text cannot hold them). CHECK constraints are re-checked by PostgreSQL
 * during the import itself (a violation rolls the whole import back).
 */
export function preflightSqlite(db: SqliteDatabase, maxPerColumn = 5): PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  const integrity = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check);
  if (integrity.join() !== "ok") for (const message of integrity) problems.push({ table: "*", problem: `integrity: ${message}` });
  for (const fk of db.prepare("PRAGMA foreign_key_check").all() as { table: string; rowid: number; parent: string }[]) {
    if (!SKIP.has(fk.table)) problems.push({ table: fk.table, rowid: fk.rowid, problem: `foreign key points to a missing ${fk.parent} row` });
  }
  for (const table of sqliteTables(db)) {
    for (const col of columns(db, table)) {
      const type = col.type.toUpperCase();
      const c = quote(col.name);
      const checks: [string, string][] = type.includes("INT")
        ? [[`typeof(${c}) <> 'integer' OR ${c} > ${INT4} OR ${c} < -${INT4 + 1}`, "not an integer within the 4-byte range"]]
        : type.includes("REAL")
          ? [[`typeof(${c}) NOT IN ('real','integer')`, "not a number"]]
          : [
              [`typeof(${c}) <> 'text'`, "stored as a non-text value in a TEXT column"],
              [`instr(CAST(${c} AS BLOB), x'00') > 0`, "contains a NUL character (not allowed in PostgreSQL text)"],
            ];
      for (const [where, problem] of checks) {
        const rows = db.prepare(`SELECT rowid AS r FROM ${quote(table)} WHERE ${c} IS NOT NULL AND (${where}) LIMIT ${maxPerColumn}`).all() as { r: number }[];
        for (const r of rows) problems.push({ table, column: col.name, rowid: r.r, problem });
      }
    }
  }
  return problems;
}

async function hasRowid(conn: MigrationConnection, table: string): Promise<boolean> {
  return (await conn.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'rowid'", [table])).rows.length > 0;
}

/**
 * Imports every app table. Refuses when pre-flight finds problems or any target table already has rows. Returns the
 * number of rows copied per table.
 */
export async function importSqliteIntoPostgres(db: SqliteDatabase, conn: MigrationConnection, options: { batchSize?: number } = {}): Promise<Record<string, number>> {
  const problems = preflightSqlite(db);
  if (problems.length) throw new Error(`SQLite pre-flight found ${problems.length} problem(s); fix them in a copy first: ${problems.slice(0, 3).map((p) => `${p.table}${p.column ? `.${p.column}` : ""}: ${p.problem}`).join("; ")}`);
  const tables = sqliteTables(db);
  for (const table of tables) {
    const n = Number((await conn.query(`SELECT COUNT(*) AS n FROM ${quote(table)}`, [])).rows[0].n);
    if (n > 0) throw new Error(`Target table ${table} is not empty; import only into a newly migrated database.`);
  }
  const batchSize = options.batchSize ?? 200;
  const copied: Record<string, number> = {};
  await conn.query("BEGIN");
  try {
    for (const table of tables) {
      const cols = columns(db, table).map((c) => c.name);
      const withRowid = await hasRowid(conn, table);
      const target = withRowid ? [...cols, "rowid"] : cols;
      const rows = db.prepare(`SELECT ${cols.map(quote).join(", ")}, rowid AS __qa_rowid FROM ${quote(table)} ORDER BY rowid`).raw().all() as unknown[][];
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const values: unknown[] = [];
        const tuples = batch.map((row) => {
          const v = withRowid ? row : row.slice(0, cols.length);
          values.push(...v);
          return `(${v.map((_, j) => `$${values.length - v.length + j + 1}`).join(", ")})`;
        });
        await conn.query(`INSERT INTO ${quote(table)} (${target.map(quote).join(", ")}) VALUES ${tuples.join(", ")}`, values);
      }
      if (withRowid) {
        // New rows must sort after every imported row.
        await conn.query(`SELECT setval(pg_get_serial_sequence($1, 'rowid'), (SELECT COALESCE(MAX(rowid), 0) + 1 FROM ${quote(table)}), false)`, [table]);
      }
      copied[table] = rows.length;
    }
    await conn.query("COMMIT");
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return copied;
}

export interface TableValidation {
  table: string;
  sqliteRows: number;
  postgresRows: number;
  sqliteDigest: string;
  postgresDigest: string;
  ok: boolean;
}

/**
 * Compares every app table: row counts, and a SHA-256 digest of all rows (every column, plus rowid where the
 * PostgreSQL table keeps it) in primary-key order. Values are normalized by the SQLite column type so driver
 * representations (e.g. bigint as text) do not matter.
 */
export async function validateImport(db: SqliteDatabase, conn: MigrationConnection): Promise<{ ok: boolean; tables: TableValidation[] }> {
  const tables: TableValidation[] = [];
  for (const table of sqliteTables(db)) {
    const cols = columns(db, table);
    const pk = cols.filter((c) => c.pk).map((c) => c.name);
    const withRowid = await hasRowid(conn, table);
    const numeric = new Set(cols.filter((c) => /INT|REAL/i.test(c.type)).map((c) => c.name));
    const names = [...cols.map((c) => c.name), ...(withRowid ? ["rowid"] : [])];
    if (withRowid) numeric.add("rowid");
    const norm = (row: Record<string, unknown>) => names.map((n) => (row[n] === null || row[n] === undefined ? null : numeric.has(n) ? Number(row[n]) : String(row[n])));
    const digest = (rows: Record<string, unknown>[]) => {
      const h = createHash("sha256");
      for (const r of rows) h.update(JSON.stringify(norm(r)) + "\n");
      return h.digest("hex");
    };
    const select = (rowidExpr: string) => `SELECT ${cols.map((c) => quote(c.name)).join(", ")}${withRowid ? `, ${rowidExpr} AS rowid` : ""} FROM ${quote(table)}`;
    // Byte-wise primary-key order on both sides (PostgreSQL's default collation may sort text differently).
    const liteRows = db.prepare(`${select("rowid")} ORDER BY ${pk.map((k) => `${quote(k)} COLLATE BINARY`).join(", ")}`).all() as Record<string, unknown>[];
    const pgRows = (await conn.query(`${select("rowid")} ORDER BY ${pk.map((k) => `${quote(k)} COLLATE "C"`).join(", ")}`, [])).rows;
    const v = { table, sqliteRows: liteRows.length, postgresRows: pgRows.length, sqliteDigest: digest(liteRows), postgresDigest: digest(pgRows) };
    tables.push({ ...v, ok: v.sqliteRows === v.postgresRows && v.sqliteDigest === v.postgresDigest });
  }
  return { ok: tables.every((t) => t.ok), tables };
}
