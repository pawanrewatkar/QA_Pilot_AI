import type { AppEnv } from "@/lib/config/env";

/**
 * Starts the GitHub Actions worker (.github/workflows/qa-worker.yml) when the web app queues work, through GitHub's
 * "create a workflow dispatch event" API. The worker then processes everything queued and exits; the workflow allows
 * one run at a time, so extra requests just wait their turn. An hourly schedule in the workflow picks up anything a
 * failed request left behind.
 *
 * Never throws and never blocks the user: callers run it after the response (next/server `after`). The token is
 * server-only and never appears in results or logs.
 */

export interface WorkerDispatchConfig {
  token: string;
  repository: string;
  workflow: string;
  ref: string;
}

export type DispatchResult =
  | { status: "disabled" }
  | { status: "throttled" }
  | { status: "requested" }
  | { status: "failed"; reason: string };

/** How queued work gets a worker: started automatically, started by hand on GitHub, or a local `npm run worker`. */
export type WorkerLaunchMode = "github-auto" | "github-manual" | "local";

type DispatchEnv = Pick<AppEnv, "GITHUB_WORKER_TOKEN" | "GITHUB_WORKER_REPOSITORY" | "GITHUB_WORKER_WORKFLOW" | "GITHUB_WORKER_REF">;

/** The dispatch settings, or null when automatic starts are not configured (token or repository missing). */
export function workerDispatchConfig(env: DispatchEnv): WorkerDispatchConfig | null {
  const token = env.GITHUB_WORKER_TOKEN?.trim();
  const repository = env.GITHUB_WORKER_REPOSITORY?.trim();
  if (!token || /\s/.test(token) || !repository) return null;
  return { token, repository, workflow: env.GITHUB_WORKER_WORKFLOW, ref: env.GITHUB_WORKER_REF };
}

export function workerLaunchMode(env: DispatchEnv, runtime: { vercel: boolean }): WorkerLaunchMode {
  if (workerDispatchConfig(env)) return "github-auto";
  return runtime.vercel ? "github-manual" : "local";
}

/** Minimum time between two requests from one server instance; the running worker picks up work queued meanwhile. */
export const DISPATCH_THROTTLE_MS = 30_000;
const DISPATCH_TIMEOUT_MS = 10_000;
let lastRequestedAt = Number.NEGATIVE_INFINITY;

/** Test hook: forget the last request time. */
export function resetDispatchThrottle(): void {
  lastRequestedAt = Number.NEGATIVE_INFINITY;
}

const REASONS: Record<number, string> = {
  401: "GitHub rejected the token (expired or revoked): check GITHUB_WORKER_TOKEN",
  403: "the token may not start workflows: it needs Actions read & write on this repository",
  404: "repository or workflow not found, or the token has no access to it: check GITHUB_WORKER_REPOSITORY and the token's repository access",
  422: "GitHub refused the request: check GITHUB_WORKER_REF (branch) and that the workflow allows manual runs",
};

export async function requestWorkerRun(
  config: WorkerDispatchConfig | null,
  options: { fetchImpl?: typeof fetch; now?: () => number; log?: (message: string) => void } = {},
): Promise<DispatchResult> {
  if (!config) return { status: "disabled" };
  const now = (options.now ?? Date.now)();
  if (now - lastRequestedAt < DISPATCH_THROTTLE_MS) return { status: "throttled" };
  lastRequestedAt = now;
  const log = options.log ?? ((m: string) => console.warn(m));
  const url = `https://api.github.com/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`;
  let result: DispatchResult;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "qa-pilot-ai",
      },
      body: JSON.stringify({ ref: config.ref }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    result = response.ok ? { status: "requested" } : { status: "failed", reason: `HTTP ${response.status}: ${REASONS[response.status] ?? "unexpected response from GitHub"}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    result = { status: "failed", reason: name === "TimeoutError" || name === "AbortError" ? "GitHub did not answer within 10 seconds" : `network error (${name})` };
  }
  if (result.status === "failed") {
    lastRequestedAt = Number.NEGATIVE_INFINITY; // let the next queued job try again
    log(`[worker-dispatch] Could not start the worker: ${result.reason}. Queued work waits for the next run (hourly schedule or manual).`);
  }
  return result;
}
