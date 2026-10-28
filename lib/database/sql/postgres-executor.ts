import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { SqlExecutor, SqlRunResult, SqlValue } from "./executor";

/** The parts of a `pg` client this executor uses (a structural type, so tests can supply a fake). */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  /** Returns the client to the pool; passing an error destroys it instead (it may be in an unknown state). */
  release(error?: Error): void;
}

/** The parts of a `pg` pool this executor uses. */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

/**
 * Rewrites positional `?` placeholders to PostgreSQL's `$1…$n`, leaving `?` untouched inside string literals
 * ('…', E'…'), quoted identifiers ("…"), dollar-quoted strings ($$…$$, $tag$…$tag$) and comments (--, nested /* *\/).
 * PostgreSQL operators that contain `?` (jsonb `?`, `?|`, `?&`) cannot be used with this convention; use
 * `jsonb_exists` and friends instead.
 */
export function toPostgresPlaceholders(sql: string): { text: string; count: number } {
  let out = "";
  let count = 0;
  let i = 0;
  const n = sql.length;
  const isIdent = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'") {
      // E'…' strings also treat backslash as an escape character.
      const escapes = (sql[i - 1] === "E" || sql[i - 1] === "e") && !isIdent(sql[i - 2]);
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const j = end === -1 ? n : end;
      out += sql.slice(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      out += sql.slice(i, j);
      i = j;
    } else if (c === "$" && !isIdent(sql[i - 1]) && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)![0];
      const end = sql.indexOf(tag, i + tag.length);
      const j = end === -1 ? n : end + tag.length;
      out += sql.slice(i, j);
      i = j;
    } else if (c === "?") {
      out += `$${++count}`;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return { text: out, count };
}

/** `pg` sends bigint as text; convert explicitly so the value is never mangled. */
const toPg = (v: SqlValue) => (typeof v === "bigint" ? v.toString() : v);
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/**
 * SqlExecutor over a PostgreSQL pool (`pg`).
 *
 * Statements outside a transaction use any pooled connection. A transaction checks out one client, and every
 * statement inside it (on `tx` or on this executor, from the same async flow) runs on that client; nested calls
 * become savepoints. Unlike SqliteExecutor, transactions from different async flows are not serialized: each has
 * its own connection and PostgreSQL isolates them (READ COMMITTED by default).
 *
 * Errors are never logged here: they propagate to the caller unchanged.
 */
export class PostgresExecutor implements SqlExecutor {
  readonly dialect = "postgres" as const;
  private readonly context = new AsyncLocalStorage<{ client: PgClientLike; savepoints: number }>();

  constructor(private readonly pool: PgPoolLike) {}

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return (await this.query(sql, params)).rows as T[];
  }

  async get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    return (await this.query(sql, params)).rows[0] as T | undefined;
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<SqlRunResult> {
    return { changes: (await this.query(sql, params)).rowCount ?? 0 };
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const ctx = this.context.getStore();
    if (ctx) return this.savepoint(ctx, fn);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
    } catch (error) {
      client.release(asError(error));
      throw error;
    }
    let broken: Error | undefined;
    try {
      const value = await this.context.run({ client, savepoints: 0 }, () => fn(this));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        broken = asError(rollbackError); // the connection is unusable: destroy it rather than reuse it
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  /** Closes the pool. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  private async savepoint<T>(ctx: { client: PgClientLike; savepoints: number }, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const name = `qa_sp_${++ctx.savepoints}`;
    try {
      await ctx.client.query(`SAVEPOINT ${name}`);
      try {
        const value = await fn(this);
        await ctx.client.query(`RELEASE SAVEPOINT ${name}`);
        return value;
      } catch (error) {
        try {
          await ctx.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          await ctx.client.query(`RELEASE SAVEPOINT ${name}`);
        } catch {
          // The enclosing transaction is aborted and will be rolled back; report the original error.
        }
        throw error;
      }
    } finally {
      ctx.savepoints--;
    }
  }

  private async query(sql: string, params: readonly SqlValue[]) {
    const { text, count } = toPostgresPlaceholders(sql);
    if (count !== params.length) throw new RangeError(`Expected ${count} parameter value(s) but received ${params.length}`);
    const target = this.context.getStore()?.client ?? this.pool;
    return target.query(text, params.map(toPg));
  }
}

/**
 * Opens a pool for `connectionString`. No connection is made until the first query. The connection string is never
 * logged or included in errors raised here.
 */
export function createPostgresExecutor(connectionString: string, createPool: (connectionString: string) => PgPoolLike = defaultPool): PostgresExecutor {
  return new PostgresExecutor(createPool(connectionString));
}

function defaultPool(connectionString: string): PgPoolLike {
  const pool = new pg.Pool({ connectionString });
  // An idle client can fail (e.g. the server restarts); without a listener `pg` would crash the process.
  // Log only the error code, never connection details.
  pool.on("error", (error: Error & { code?: string }) => console.error(`PostgreSQL idle connection error (${error.code ?? error.name})`));
  return pool as unknown as PgPoolLike;
}
