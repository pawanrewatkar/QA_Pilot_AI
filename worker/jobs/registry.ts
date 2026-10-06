import type { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { StorageProvider } from "@/lib/storage/provider";
import { executeCrawl } from "../crawler/crawl-job";
import { executeRun } from "../test-engine/run-executor";
import type { Job, JobType } from "./job-queue";

export interface JobContext {
  workerId: string;
  signal: AbortSignal;
  log: (message: string) => void;
  store: SqliteEngineStore;
  storage: StorageProvider;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

/** Job handlers by type. Report generation registers here in a later phase. */
export const JOB_HANDLERS: Partial<Record<JobType, JobHandler>> = {
  "crawl.project": async (job, ctx) => {
    const { crawlRunId } = job.payload as { crawlRunId: string };
    await executeCrawl(crawlRunId, { store: ctx.store, log: ctx.log, signal: ctx.signal });
  },
  "run.execute": async (job, ctx) => {
    const { testRunId } = job.payload as { testRunId: string };
    const summary = await executeRun(testRunId, { store: ctx.store, storage: ctx.storage, log: ctx.log, signal: ctx.signal });
    ctx.log(`Run ${testRunId} ${summary.status}: ${summary.results} results${summary.error ? ` (${summary.error})` : ""}`);
  },
};

export function registeredJobTypes(): JobType[] {
  return Object.keys(JOB_HANDLERS) as JobType[];
}
