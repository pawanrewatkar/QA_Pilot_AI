import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import type { SqliteDatabase } from "../local/sqlite-client";
import type { SqlExecutor, SqlRunResult, SqlValue } from "./executor";

const MAX_CACHED_STATEMENTS = 500;

/**
 * SqlExecutor over one better-sqlite3 connection.
 *
 * Statements run synchronously (results are identical to calling `db.prepare(sql)` directly); the async
 * interface exists so the same calling code can later run on PostgreSQL.
 *
 * Transactions span `await`s, so they are serialized per connection: while one is open, calls from other
 * async flows wait until it commits or rolls back, and calls made inside it (on `tx` or on this executor) join
 * it. `BEGIN IMMEDIATE` takes the write lock up front so another process (the worker) cannot cause a
 * deadlock part-way through.
 *
 * Transition rule: code that still calls `db.prepare` directly on the same connection bypasses this
 * serialization. Until every in-process caller of a connection goes through the executor, production code
 * must not use `transaction()` on it.
 */
export class SqliteExecutor implements SqlExecutor {
  readonly dialect = "sqlite" as const;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly context = new AsyncLocalStorage<{ savepoints: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private openTransactions = 0;

  constructor(private readonly db: SqliteDatabase) {}

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    await this.ready();
    return this.statement(sql).all(...params) as T[];
  }

  async get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    await this.ready();
    return this.statement(sql).get(...params) as T | undefined;
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<SqlRunResult> {
    await this.ready();
    return { changes: this.statement(sql).run(...params).changes };
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const ctx = this.context.getStore();
    if (ctx) return this.savepoint(ctx, fn);
    const result = this.queue.then(() => this.runTransaction(fn));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async runTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.openTransactions++;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = await this.context.run({ savepoints: 0 }, () => fn(this));
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        if (this.db.inTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.openTransactions--;
    }
  }

  private async savepoint<T>(ctx: { savepoints: number }, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const name = `qa_sp_${++ctx.savepoints}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const value = await fn(this);
      this.db.exec(`RELEASE ${name}`);
      return value;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      ctx.savepoints--;
    }
  }

  /** Outside a transaction, waits while another async flow has one open on this connection. */
  private async ready(): Promise<void> {
    if (this.context.getStore()) return;
    while (this.openTransactions > 0) await this.queue;
  }

  private statement(sql: string): Database.Statement {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      if (this.statements.size >= MAX_CACHED_STATEMENTS) this.statements.clear();
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }
}
