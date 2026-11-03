import { hostname } from "node:os";
import type { EngineStore } from "@/lib/database/local/engine-store";
import type { StorageProvider } from "@/lib/storage/provider";
import type { JobQueue, JobType } from "./jobs/job-queue";
import type { JobHandler } from "./jobs/registry";

const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 5000;
/** A worker that has not heart-beaten for this long is considered dead and its jobs are failed. */
export const WORKER_STALE_AFTER_MS = 30_000;

export interface WorkerOptions {
  store: EngineStore;
  queue: JobQueue;
  storage: StorageProvider;
  handlers: Partial<Record<JobType, JobHandler>>;
  workerId: string;
  log: (message: string) => void;
  /** Aborted on shutdown: no new job is claimed and the job in progress stops at its next check. */
  signal: AbortSignal;
  /** Exit when the queue is empty instead of polling. */
  once: boolean;
  /** Stop claiming new jobs after this time (ms since the epoch); null for no limit. */
  deadline: number | null;
  pollIntervalMs?: number;
}

export interface WorkerOutcome {
  processed: number;
  failed: number;
  recovered: number;
  stoppedBy: "empty-queue" | "deadline" | "signal";
}

/**
 * The worker's whole lifecycle on one database and storage: heartbeat, recovery of work left by stopped workers, then
 * claiming and running jobs one at a time until the queue is empty (`once`), the deadline passes, or the signal stops it.
 * Each job ends COMPLETED or FAILED with its error; the heartbeat is removed on the way out.
 */
export async function runWorker(o: WorkerOptions): Promise<WorkerOutcome> {
  const types = Object.keys(o.handlers) as JobType[];
  const startedAt = new Date().toISOString();
  const beat = () => o.store.heartbeat(o.workerId, hostname(), process.pid, types, startedAt);
  await beat();
  const heartbeat = setInterval(() => void beat().catch((error: unknown) => o.log(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  const outcome: WorkerOutcome = { processed: 0, failed: 0, recovered: 0, stoppedBy: "signal" };
  try {
    outcome.recovered = await o.store.recoverAbandonedWork(WORKER_STALE_AFTER_MS);
    if (outcome.recovered) o.log(`Marked ${outcome.recovered} job(s) from a stopped worker as FAILED.`);
    o.log(`Started as ${o.workerId}. Handlers: ${types.join(", ")}.`);

    while (!o.signal.aborted) {
      if (o.deadline !== null && Date.now() >= o.deadline) {
        o.log("Reached the runtime limit; not claiming new jobs.");
        outcome.stoppedBy = "deadline";
        break;
      }
      const job = await o.queue.claim(o.workerId, types);
      if (job) {
        const handler = o.handlers[job.type]!;
        o.log(`Running job ${job.id} (${job.type}, attempt ${job.attempts})`);
        outcome.processed++;
        try {
          await handler(job, { workerId: o.workerId, signal: o.signal, log: o.log, store: o.store, storage: o.storage });
          await o.queue.complete(job.id);
          o.log(`Completed job ${job.id}`);
        } catch (error) {
          outcome.failed++;
          const after = await o.queue.fail(job.id, error instanceof Error ? (error.stack ?? error.message) : String(error));
          o.log(`Job ${job.id} failed: ${after?.status === "PENDING" ? "will retry" : "giving up"} — ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (o.once) {
        outcome.stoppedBy = "empty-queue";
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, o.pollIntervalMs ?? POLL_INTERVAL_MS));
    }
  } finally {
    clearInterval(heartbeat);
    await o.store.removeHeartbeat(o.workerId).catch(() => undefined);
  }
  return outcome;
}
