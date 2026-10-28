/**
 * Database-neutral, async SQL access (preparation for a PostgreSQL provider; see project-memory/Memory.md §11 / Step 3).
 *
 * Code written against this interface runs on SQLite today (SqliteExecutor) and is meant to run unchanged on
 * PostgreSQL later. Rules for SQL passed here:
 * - Positional `?` placeholders only (a PostgreSQL executor rewrites them to `$1…$n`).
 * - Standard SQL only: no `rowid`, `INSERT OR …`, `json_extract`, `strftime`, `PRAGMA`, or reliance on
 *   SQLite's case-insensitive `LIKE` / NULLS-first ordering.
 * - No `lastInsertRowid`; use application-generated ids (the app already uses UUIDs).
 */
export type SqlValue = string | number | bigint | null | Buffer;

export interface SqlRunResult {
  /** Rows inserted, updated or deleted. */
  changes: number;
}

export interface SqlExecutor {
  readonly dialect: "sqlite" | "postgres";
  /** All rows of a query. */
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** The first row of a query, or undefined. */
  get<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  /** Executes a write statement. */
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlRunResult>;
  /**
   * Runs `fn` in a transaction: committed when it resolves, rolled back when it throws. Nested calls become
   * savepoints and must be awaited one at a time (not in parallel).
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
