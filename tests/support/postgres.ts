import { PGlite } from "@electric-sql/pglite";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { PostgresExecutor, type PgClientLike, type PgPoolLike } from "@/lib/database/sql/postgres-executor";

/**
 * Test-only PostgreSQL environment: an in-process PGlite database (real PostgreSQL compiled to WebAssembly; no
 * server, no network) with a schema generated from the app's own SQLite schema, so both backends have the same
 * tables, columns, constraints, defaults and indexes.
 *
 * Translation (test schema only; the production PostgreSQL schema is still to be designed):
 * - `strftime('%Y-%m-%dT%H:%M:%fZ','now')` defaults → the same ISO-8601 UTC text from `now()`.
 * - `REAL` → `DOUBLE PRECISION`; `INTEGER` stays `integer` (4 bytes: every value the app stores fits, and `pg`
 *   returns it as a number like SQLite does).
 * - Timestamps and JSON stay TEXT, ids stay TEXT, booleans stay 0/1 integers: the repositories expect these.
 * - `COLLATE NOCASE` index → `lower(...)` expression index.
 * - Every table gets `rowid BIGINT GENERATED ALWAYS AS IDENTITY`: SQLite's implicit insertion-order column, which
 *   several queries use as a tie-break. This is one candidate for the production design, not a decision.
 */

const PG_NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface SchemaStatement {
  type: "table" | "index";
  name: string;
  sql: string;
}

/** The app's SQLite schema after all migrations, as stored by SQLite. */
export function sqliteSchema(): SchemaStatement[] {
  const db = LocalDatabaseProvider.open(":memory:");
  try {
    return db.sqlite
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
      .all() as SchemaStatement[];
  } finally {
    void db.close();
  }
}

const unquote = (name: string) => name.replace(/"/g, "");

/** PostgreSQL DDL for the same schema: tables in foreign-key order, then indexes. */
export function postgresSchema(): string[] {
  const statements = sqliteSchema();
  const tables = statements.filter((s) => s.type === "table");
  const pending = new Map(tables.map((t) => [t.name, t]));
  const ordered: SchemaStatement[] = [];
  while (pending.size) {
    const ready = [...pending.values()].find((t) =>
      [...t.sql.matchAll(/REFERENCES\s+("?\w+"?)/g)].every((m) => unquote(m[1]) === t.name || !pending.has(unquote(m[1]))),
    );
    if (!ready) throw new Error(`Circular foreign keys among: ${[...pending.keys()].join(", ")}`);
    ordered.push(ready);
    pending.delete(ready.name);
  }
  const table = (sql: string) =>
    sql
      .replace(/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*'now'\)/g, PG_NOW)
      .replace(/\bREAL\b/gi, "DOUBLE PRECISION")
      .replace(/^(CREATE TABLE\s+"?\w+"?\s*\()/, "$1\n  rowid BIGINT GENERATED ALWAYS AS IDENTITY,");
  const index = (sql: string) => sql.replace(/\b(\w+) COLLATE NOCASE\b/g, "lower($1)");
  return [...ordered.map((t) => table(t.sql)), ...statements.filter((s) => s.type === "index").map((s) => index(s.sql))];
}

/** PGlite has one connection: a checked-out client holds it exclusively until released (pool queries wait). */
function pglitePool(db: PGlite): PgPoolLike {
  let tail: Promise<void> = Promise.resolve();
  const lock = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const acquired = tail.then(() => release);
    tail = tail.then(() => held);
    return acquired;
  };
  const query = async (text: string, values?: unknown[]) => {
    const r = await db.query(text, values as unknown[] | undefined);
    return { rows: r.rows as unknown[], rowCount: r.affectedRows ?? 0 };
  };
  return {
    query: async (text, values) => {
      const release = await lock();
      try {
        return await query(text, values);
      } finally {
        release();
      }
    },
    connect: async (): Promise<PgClientLike> => {
      const release = await lock();
      let released = false;
      return {
        query,
        release: () => {
          if (released) return;
          released = true;
          release();
        },
      };
    },
    end: async () => {},
  };
}

export interface PgTestDatabase {
  sql: PostgresExecutor;
  db: PGlite;
  tables: string[];
  /** Empties every table (identity columns restart) so each test starts from a clean database. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A fresh PGlite database with the translated schema. Create one per test file; `reset()` between tests. */
export async function createPgTestDatabase(): Promise<PgTestDatabase> {
  const db = new PGlite();
  const ddl = postgresSchema();
  for (const statement of ddl) await db.exec(statement);
  const tables = sqliteSchema()
    .filter((s) => s.type === "table")
    .map((s) => s.name);
  return {
    sql: new PostgresExecutor(pglitePool(db)),
    db,
    tables,
    reset: async () => void (await db.exec(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`)),
    close: () => db.close(),
  };
}

/** Stand-in for the raw SQLite connection: any use fails the test (the methods under test must not need it). */
export const noRawConnection = new Proxy(
  {},
  {
    get(_target, key) {
      throw new Error(`Raw SQLite connection used on PostgreSQL (property "${String(key)}")`);
    },
  },
) as never;
