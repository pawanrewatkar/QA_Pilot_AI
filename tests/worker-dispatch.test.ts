import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "@/lib/config/env";
import { DISPATCH_THROTTLE_MS, requestWorkerRun, resetDispatchThrottle, workerDispatchConfig, workerLaunchMode } from "@/lib/worker/dispatch";

/** Starting the GitHub Actions worker when the web app queues work (lib/worker/dispatch.ts). No network: fetch is faked. */

const TOKEN = "github_pat_CANARYTOKEN0000000000000000";
const ENV = { GITHUB_WORKER_TOKEN: TOKEN, GITHUB_WORKER_REPOSITORY: "pawanrewatkar/QA_Pilot_AI" };
const config = () => workerDispatchConfig(readEnv(ENV))!;

function fakeFetch(status: number | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (status instanceof Error) throw status;
    return new Response(null, { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

beforeEach(() => resetDispatchThrottle());
afterEach(() => vi.restoreAllMocks());

describe("configuration", () => {
  it("is off unless both the token and the repository are set (manual starts, as before)", () => {
    expect(workerDispatchConfig(readEnv({}))).toBeNull();
    expect(workerDispatchConfig(readEnv({ GITHUB_WORKER_TOKEN: TOKEN }))).toBeNull();
    expect(workerDispatchConfig(readEnv({ GITHUB_WORKER_REPOSITORY: "o/r" }))).toBeNull();
    expect(workerDispatchConfig(readEnv({ ...ENV, GITHUB_WORKER_TOKEN: "with space" }))).toBeNull();
    expect(config()).toEqual({ token: TOKEN, repository: "pawanrewatkar/QA_Pilot_AI", workflow: "qa-worker.yml", ref: "main" });
  });

  it("validates the repository, workflow and branch, naming the setting but never the token", () => {
    for (const [key, value] of [["GITHUB_WORKER_REPOSITORY", "not a repo"], ["GITHUB_WORKER_REPOSITORY", "a/b/c"], ["GITHUB_WORKER_WORKFLOW", "../x.sh"], ["GITHUB_WORKER_REF", "main; rm"]]) {
      let message = "";
      try {
        readEnv({ ...ENV, [key]: value });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, `${key}=${value}`).toMatch(new RegExp(key));
      expect(message).not.toContain(TOKEN);
    }
  });

  it("chooses the banner mode: automatic, manual on a hosted deployment, or local", () => {
    expect(workerLaunchMode(readEnv(ENV), { vercel: true })).toBe("github-auto");
    expect(workerLaunchMode(readEnv({}), { vercel: true })).toBe("github-manual");
    expect(workerLaunchMode(readEnv({}), { vercel: false })).toBe("local");
  });
});

describe("requesting a worker run", () => {
  it("does nothing when not configured", async () => {
    const f = fakeFetch(204);
    expect(await requestWorkerRun(null, { fetchImpl: f.fn })).toEqual({ status: "disabled" });
    expect(f.calls).toHaveLength(0);
  });

  it("sends one workflow-dispatch request for the configured workflow and branch", async () => {
    const f = fakeFetch(204);
    expect(await requestWorkerRun(config(), { fetchImpl: f.fn })).toEqual({ status: "requested" });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe("https://api.github.com/repos/pawanrewatkar/QA_Pilot_AI/actions/workflows/qa-worker.yml/dispatches");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
    expect(JSON.parse(String(init.body))).toEqual({ ref: "main" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends at most one request per throttle window per instance; a failure lets the next one through", async () => {
    let t = 1_000_000;
    const now = () => t;
    const ok = fakeFetch(204);
    expect((await requestWorkerRun(config(), { fetchImpl: ok.fn, now })).status).toBe("requested");
    t += DISPATCH_THROTTLE_MS - 1;
    expect((await requestWorkerRun(config(), { fetchImpl: ok.fn, now })).status).toBe("throttled");
    t += 1;
    expect((await requestWorkerRun(config(), { fetchImpl: ok.fn, now })).status).toBe("requested");
    expect(ok.calls).toHaveLength(2);

    resetDispatchThrottle();
    const bad = fakeFetch(500);
    expect((await requestWorkerRun(config(), { fetchImpl: bad.fn, now, log: () => undefined })).status).toBe("failed");
    expect((await requestWorkerRun(config(), { fetchImpl: ok.fn, now })).status).toBe("requested"); // not throttled after a failure
  });

  it("explains failures without ever exposing the token, and never throws", async () => {
    const cases: [number | Error, RegExp][] = [
      [401, /HTTP 401: .*expired or revoked/],
      [403, /HTTP 403: .*Actions read & write/],
      [404, /HTTP 404: .*repository or workflow not found/],
      [422, /HTTP 422: .*GITHUB_WORKER_REF/],
      [500, /HTTP 500: unexpected response/],
      [Object.assign(new Error("timed out"), { name: "TimeoutError" }), /did not answer within 10 seconds/],
      [new TypeError("fetch failed"), /network error \(TypeError\)/],
    ];
    for (const [status, expected] of cases) {
      resetDispatchThrottle();
      const logs: string[] = [];
      const result = await requestWorkerRun(config(), { fetchImpl: fakeFetch(status).fn, log: (m) => logs.push(m) });
      expect(result.status, String(status)).toBe("failed");
      expect(result.status === "failed" && result.reason, String(status)).toMatch(expected);
      expect(logs.join("\n")).toMatch(/Could not start the worker/);
      expect(JSON.stringify(result) + logs.join("\n")).not.toContain(TOKEN);
    }
  });
});
