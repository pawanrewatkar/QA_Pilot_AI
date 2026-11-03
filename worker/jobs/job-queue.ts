import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "@/lib/database/sql/executor";
import type { JobStatus } from "@/types";

export type JobType = "crawl.project" | "run.execute" | "report.generate";

export interface Job<P = unknown> {
  id: string;
  type: JobType;
  payload: P;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

type Row = Record<string, unknown>;

function mapJob(row: Row): Job {
  return {
    id: String(row.id),
    type: String(row.type) as JobType,
    payload: JSON.parse(String(row.payload)),
    status: String(row.status) as JobStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

/**
 * Durable work queue on the `jobs` table. The web app enqueues; worker processes claim. Claiming is a single
 * UPDATE … RETURNING so two workers never take the same job: SQLite allows one writer at a time, and on PostgreSQL the
 * candidate row is locked with FOR UPDATE SKIP LOCKED (concurrent workers skip it) and re-checked as still PENDING.
 */
export class JobQueue {
  constructor(private readonly sql: SqlExecutor) {}

  async enqueue<P>(type: JobType, payload: P, options: { maxAttempts?: number; runAfter?: Date } = {}): Promise<Job<P>> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.sql.run(
      `INSERT INTO jobs (id, type, payload, status, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
      [id, type, JSON.stringify(payload), options.maxAttempts ?? 3, (options.runAfter ?? new Date()).toISOString(), now, now],
    );
    return (await this.get(id)) as Job<P>;
  }

  async get(id: string): Promise<Job | null> {
    const row = await this.sql.get<Row>("SELECT * FROM jobs WHERE id = ?", [id]);
    return row ? mapJob(row) : null;
  }

  /** Atomically claims the oldest due PENDING job whose type is in `types`. */
  async claim(workerId: string, types: readonly JobType[]): Promise<Job | null> {
    if (types.length === 0) return null;
    const now = new Date().toISOString();
    const postgres = this.sql.dialect === "postgres";
    const row = await this.sql.get<Row>(
      `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, locked_at = ?, locked_by = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'PENDING' AND run_after <= ? AND type IN (${types.map(() => "?").join(",")})
           ORDER BY run_after ASC, rowid ASC LIMIT 1${postgres ? " FOR UPDATE SKIP LOCKED" : ""}
         )${postgres ? " AND status = 'PENDING'" : ""}
         RETURNING *`,
      [now, workerId, now, now, ...types],
    );
    return row ? mapJob(row) : null;
  }

  async complete(id: string): Promise<void> {
    await this.sql.run(`UPDATE jobs SET status = 'COMPLETED', locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  }

  /** Records a failure; re-queues with exponential backoff until max attempts is reached. */
  async fail(id: string, error: string): Promise<Job | null> {
    const job = await this.get(id);
    if (!job) return null;
    const now = Date.now();
    const retry = job.attempts < job.maxAttempts;
    const runAfter = new Date(now + Math.min(60_000, 1000 * 2 ** job.attempts)).toISOString();
    await this.sql.run(`UPDATE jobs SET status = ?, last_error = ?, run_after = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?`, [
      retry ? "PENDING" : "FAILED",
      error.slice(0, 4000),
      runAfter,
      new Date(now).toISOString(),
      id,
    ]);
    return this.get(id);
  }

  async cancel(id: string): Promise<boolean> {
    return (await this.sql.run(`UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status IN ('PENDING','RUNNING')`, [new Date().toISOString(), id])).changes > 0;
  }
}
