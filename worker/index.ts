/**
 * QA Pilot AI background worker.
 *
 * Long-running browser automation (crawling and Playwright test execution) runs here as a
 * separate Node process, never inside Next.js request handlers or Vercel serverless functions.
 * It shares the database with the web app: the app enqueues jobs, the worker claims them.
 *
 *   npm run worker            # poll continuously
 *   npm run worker -- --once  # process available jobs, then exit
 */
import { hostname } from "node:os";
import { readEnv, resolveFromRoot } from "@/lib/config/env";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { SqliteJobQueue } from "./jobs/job-queue";
import { JOB_HANDLERS, registeredJobTypes } from "./jobs/registry";

const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 5000;
/** A worker that has not heart-beaten for this long is considered dead and its jobs are failed. */
export const WORKER_STALE_AFTER_MS = 30_000;

async function main() {
  const once = process.argv.includes("--once");
  const env = readEnv();
  if (env.DATABASE_PROVIDER !== "local") throw new Error("The worker currently supports DATABASE_PROVIDER=local only.");

  const db = LocalDatabaseProvider.open(resolveFromRoot(env.DATABASE_PATH));
  const store = new SqliteEngineStore(db.sqlite);
  const storage = new LocalStorageProvider(resolveFromRoot(env.STORAGE_PATH));
  const queue = new SqliteJobQueue(db.sqlite);
  const workerId = `${hostname()}:${process.pid}`;
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const log = (message: string) => console.log(`[worker ${new Date().toISOString()}] ${message}`);
  const types = registeredJobTypes();

  const beat = () => store.heartbeat(workerId, hostname(), process.pid, types, startedAt);
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  const recovered = store.recoverAbandonedWork(WORKER_STALE_AFTER_MS);
  if (recovered) log(`Marked ${recovered} job(s) from a stopped worker as FAILED.`);

  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("Shutting down (finishing the current step)…");
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`Started as ${workerId}. Handlers: ${types.join(", ")}.`);

  while (!controller.signal.aborted) {
    const job = queue.claim(workerId, types);
    if (job) {
      const handler = JOB_HANDLERS[job.type]!;
      log(`Running job ${job.id} (${job.type}, attempt ${job.attempts})`);
      try {
        await handler(job, { workerId, signal: controller.signal, log, store, storage });
        queue.complete(job.id);
        log(`Completed job ${job.id}`);
      } catch (error) {
        const after = queue.fail(job.id, error instanceof Error ? (error.stack ?? error.message) : String(error));
        log(`Job ${job.id} failed: ${after?.status === "PENDING" ? "will retry" : "giving up"} — ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  clearInterval(heartbeat);
  store.removeHeartbeat(workerId);
  await db.close();
  log("Stopped.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
