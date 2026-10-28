import { PGlite } from "@electric-sql/pglite";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { applyMigrations, type Migration, type MigrationConnection } from "@/lib/database/postgres/migrator";
import { PostgresExecutor, type PgClientLike, type PgPoolLike } from "@/lib/database/sql/postgres-executor";

/**
 * Test-only PostgreSQL environment: an in-process PGlite database (real PostgreSQL compiled to WebAssembly; no
 * server, no network) with the app's versioned PostgreSQL migrations applied (lib/database/postgres/migrations).
 */

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

/** A migration connection over PGlite: statements without values may contain several commands. */
export function pgliteConnection(db: PGlite): MigrationConnection {
  return {
    query: async (text, values) => {
      if (values === undefined) {
        const results = await db.exec(text);
        return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
      }
      return { rows: (await db.query(text, values)).rows as Record<string, unknown>[] };
    },
  };
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
  conn: MigrationConnection;
  tables: string[];
  /** Empties every app table (identity columns restart) so each test starts from a clean database. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A fresh PGlite database. Migrated with the app's migrations unless `migrations` says otherwise ([] = empty). */
export async function createPgTestDatabase(migrations?: Migration[]): Promise<PgTestDatabase> {
  const db = new PGlite();
  const conn = pgliteConnection(db);
  await applyMigrations(conn, migrations);
  const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'qa_pilot_migrations'")).rows.map((r) => r.tablename);
  return {
    sql: new PostgresExecutor(pglitePool(db)),
    db,
    conn,
    tables,
    reset: async () => {
      if (tables.length) await db.exec(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    },
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
