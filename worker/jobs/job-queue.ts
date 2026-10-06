import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@/lib/database/local/sqlite-client";
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
 * Durable work queue on the `jobs` table. The web app enqueues; the worker process claims.
 * Claiming is a single UPDATE … RETURNING so two workers never take the same job.
 */
export class SqliteJobQueue {
  constructor(private readonly db: SqliteDatabase) {}

  enqueue<P>(type: JobType, payload: P, options: { maxAttempts?: number; runAfter?: Date } = {}): Job<P> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (id, type, payload, status, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
      )
      .run(id, type, JSON.stringify(payload), options.maxAttempts ?? 3, (options.runAfter ?? new Date()).toISOString(), now, now);
    return this.get(id) as Job<P>;
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  /** Atomically claims the oldest due PENDING job whose type is in `types`. */
  claim(workerId: string, types: readonly JobType[]): Job | null {
    if (types.length === 0) return null;
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, locked_at = ?, locked_by = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'PENDING' AND run_after <= ? AND type IN (${types.map(() => "?").join(",")})
           ORDER BY run_after ASC, rowid ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get(now, workerId, now, now, ...types) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  complete(id: string): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'COMPLETED', locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  /** Records a failure; re-queues with exponential backoff until max attempts is reached. */
  fail(id: string, error: string): Job | null {
    const job = this.get(id);
    if (!job) return null;
    const now = Date.now();
    const retry = job.attempts < job.maxAttempts;
    const runAfter = new Date(now + Math.min(60_000, 1000 * 2 ** job.attempts)).toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, last_error = ?, run_after = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(retry ? "PENDING" : "FAILED", error.slice(0, 4000), runAfter, new Date(now).toISOString(), id);
    return this.get(id);
  }

  cancel(id: string): boolean {
    return (
      this.db
        .prepare(`UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status IN ('PENDING','RUNNING')`)
        .run(new Date().toISOString(), id).changes > 0
    );
  }
}
