import "server-only";
import { after } from "next/server";
import { readEnv } from "@/lib/config/env";
import { requestWorkerRun, workerDispatchConfig, workerLaunchMode, type WorkerLaunchMode } from "@/lib/worker/dispatch";

/**
 * Call right after work was queued (crawl, test run, report, external execution). When automatic starts are configured,
 * asks GitHub to start the worker once the response has been sent, so the user never waits for GitHub.
 */
export function startWorkerAfterResponse(): void {
  const config = workerDispatchConfig(readEnv());
  if (!config) return;
  after(async () => {
    await requestWorkerRun(config);
  });
}

/** For pages: how queued work reaches a worker in this deployment (drives the worker status banner). */
export function currentWorkerLaunchMode(): WorkerLaunchMode {
  return workerLaunchMode(readEnv(), { vercel: !!process.env.VERCEL });
}
