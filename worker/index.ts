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
import { readEnv } from "@/lib/config/env";
import { redactText } from "@/lib/reports/redact";
import { EngineStore } from "@/lib/database/local/engine-store";
import { openDatabaseProvider } from "@/lib/database/open";
import { createStorageProvider } from "@/lib/storage/select";
import { JobQueue } from "./jobs/job-queue";
import { JOB_HANDLERS } from "./jobs/registry";
import { runWorker } from "./loop";
import { claimDeadline, publicLogLine, workerStartupProblems } from "./runtime";

async function main() {
  const once = process.argv.includes("--once");
  const env = readEnv();
  const problems = workerStartupProblems(env, { githubActions: process.env.GITHUB_ACTIONS === "true" });
  if (problems.length) throw new Error(problems.join(" "));
  const deadline = claimDeadline(env.WORKER_MAX_RUNTIME_MINUTES);
  // Same selection as the web app: both must use the same database (SQLite file, or PostgreSQL) and the same storage
  // (local files, or the private Supabase bucket). Misconfiguration stops the worker; nothing falls back.
  const db = openDatabaseProvider(env);
  const storage = createStorageProvider({ ...env, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL });
  const controller = new AbortController();
  // Log lines can contain page URLs and error text; secrets in them are redacted. On GitHub Actions (whose logs are
  // public for a public repository) web addresses are hidden as well.
  const githubActions = process.env.GITHUB_ACTIONS === "true";
  const log = (message: string) => {
    const line = redactText(message);
    console.log(`[worker ${new Date().toISOString()}] ${githubActions ? publicLogLine(line) : line}`);
  };

  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("Shutting down (finishing the current step)…");
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await runWorker({
      store: new EngineStore(db.sql),
      queue: new JobQueue(db.sql),
      storage,
      handlers: JOB_HANDLERS,
      workerId: `${hostname()}:${process.pid}`,
      log,
      signal: controller.signal,
      once,
      deadline,
    });
  } finally {
    await db.close();
  }
  log("Stopped.");
}

main().catch((error) => {
  // A startup failure (e.g. the database is unreachable) fails the process, and so the GitHub Actions run, visibly.
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(process.env.GITHUB_ACTIONS === "true" ? publicLogLine(redactText(message)) : message);
  process.exit(1);
});
