import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { readEnv } from "@/lib/config/env";
import { claimDeadline, publicLogLine, workerStartupProblems } from "@/worker/runtime";

/**
 * The GitHub Actions worker workflow (.github/workflows/qa-worker.yml) and the worker's runtime guards. The workflow
 * checks stand in for a linter: least privilege, pinned actions, secrets only where they are needed, no script
 * injection, hosted database and storage, and a runtime limit inside the job timeout.
 */

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; if?: string };
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { "timeout-minutes": number; environment: string; permissions?: unknown; steps: Step[]; env?: unknown }>;
};

const file = path.join(process.cwd(), ".github", "workflows", "qa-worker.yml");
const text = fs.readFileSync(file, "utf8");
const workflow = yaml.load(text) as Workflow;
const job = workflow.jobs.worker;
const workerStep = job.steps.find((s) => s.name === "Run worker")!;

describe("worker workflow", () => {
  it("runs only when started manually (no pull request, push or other untrusted triggers)", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(text).not.toMatch(/pull_request_target|pull_request|^\s*push:/m);
  });

  it("has read-only permissions and no job-level escalation", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const j of Object.values(workflow.jobs)) expect(j.permissions).toBeUndefined();
  });

  it("pins every action to a full commit hash and keeps no git credentials", () => {
    const uses = job.steps.filter((s) => s.uses).map((s) => s.uses!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    expect(job.steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with).toMatchObject({ "persist-credentials": false });
  });

  it("gives secrets only to the worker step, as environment variables, never inside a script", () => {
    expect(job.env).toBeUndefined();
    for (const s of job.steps) {
      if (s.run) expect(s.run, s.name).not.toMatch(/\$\{\{/); // no secrets, inputs or event data interpolated into scripts
      if (s !== workerStep) expect(JSON.stringify(s), s.name).not.toMatch(/secrets\./);
    }
    expect(workerStep.env).toMatchObject({ DATABASE_URL: "${{ secrets.DATABASE_URL }}", SUPABASE_SECRET_KEY: "${{ secrets.SUPABASE_SECRET_KEY }}" });
    expect(Object.entries(workerStep.env!).filter(([, v]) => v.includes("secrets.")).map(([k]) => k).sort()).toEqual(["DATABASE_URL", "SUPABASE_SECRET_KEY"]);
    expect(text).not.toMatch(/set -x|echo .*\$(DATABASE_URL|SUPABASE_SECRET_KEY)|NEXT_PUBLIC_/);
  });

  it("uses the hosted database and private storage, and never publishes results as GitHub artifacts", () => {
    expect(workerStep.env).toMatchObject({ DATABASE_PROVIDER: "supabase", STORAGE_PROVIDER: "supabase" });
    expect(workerStep.run).toBe("npm run worker -- --once");
    expect(text).not.toMatch(/upload-artifact/);
    expect(job.environment).toBe("qa-worker");
  });

  it("stops claiming jobs well inside the job timeout, and runs one worker at a time", () => {
    const defaultMinutes = Number((workflow.on.workflow_dispatch as { inputs: { max_runtime_minutes: { default: string } } }).inputs.max_runtime_minutes.default);
    expect(defaultMinutes).toBeGreaterThan(0);
    expect(job["timeout-minutes"] - defaultMinutes).toBeGreaterThanOrEqual(30); // room for the job in progress to finish
    expect(workflow.concurrency).toEqual({ group: "qa-worker", "cancel-in-progress": false });
  });
});

describe("worker runtime guards", () => {
  it("allows any configuration outside GitHub Actions (local development unchanged)", () => {
    expect(workerStartupProblems(readEnv({}), { githubActions: false })).toEqual([]);
  });

  it("refuses local SQLite or local files on GitHub Actions, where the machine is discarded", () => {
    const problems = workerStartupProblems(readEnv({}), { githubActions: true });
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toMatch(/DATABASE_PROVIDER=supabase.*STORAGE_PROVIDER=supabase/);
    expect(workerStartupProblems(readEnv({ DATABASE_PROVIDER: "supabase", STORAGE_PROVIDER: "supabase" }), { githubActions: true })).toEqual([]);
    expect(workerStartupProblems(readEnv({ DATABASE_PROVIDER: "supabase" }), { githubActions: true })).toHaveLength(1);
  });

  it("hides web addresses in log lines meant for public runner logs, keeping the rest", () => {
    expect(publicLogLine("Page https://customer.example/checkout?id=7 (chromium desktop) stopped: net::ERR_NAME_NOT_RESOLVED at https://cdn.customer.example/a.js")).toBe(
      "Page <url> (chromium desktop) stopped: net::ERR_NAME_NOT_RESOLVED at <url>",
    );
    expect(publicLogLine('Crawl c1: start "http://shop.test/" (robots.txt found)')).toBe('Crawl c1: start "<url>" (robots.txt found)');
    expect(publicLogLine("Run r1 COMPLETED: 12 results")).toBe("Run r1 COMPLETED: 12 results");
  });

  it("computes the claim deadline from WORKER_MAX_RUNTIME_MINUTES, with no limit by default", () => {
    expect(readEnv({}).WORKER_MAX_RUNTIME_MINUTES).toBeUndefined();
    expect(claimDeadline(undefined, 1_000)).toBeNull();
    expect(claimDeadline(readEnv({ WORKER_MAX_RUNTIME_MINUTES: "45" }).WORKER_MAX_RUNTIME_MINUTES, 1_000)).toBe(1_000 + 45 * 60_000);
    for (const bad of ["0", "-5", "abc", "1000"]) expect(() => readEnv({ WORKER_MAX_RUNTIME_MINUTES: bad }), bad).toThrow(/WORKER_MAX_RUNTIME_MINUTES/);
  });
});
