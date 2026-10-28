import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { countsFor, runDetail } from "@/lib/database/local/engine-repositories";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import type { TestRun } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Test runs repository: `getDetail`, `countsByRun` and `requestCancel` (in-memory SQLite only). Pins full detail
 * records with their defaults, result counts, cancellation eligibility and ownership, so the read methods can move
 * onto the SQL executor unchanged. The synchronous helpers still used elsewhere (reports, history) must keep
 * returning the same values. Runs are created through createAndEnqueue; other state is seeded directly.
 *
 * Set QA_RUN_DETAIL_BEHAVIOUR_OUT to a file path to also write the normalized observations as JSON (used to compare
 * the implementation before and after a refactor).
 */

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-03-02T10:00:00.000Z";
const ZERO = { PASS: 0, FAIL: 0, WARNING: 0, "NOT EXECUTED": 0, "NOT APPLICABLE": 0 };

let base: LocalDatabaseProvider;
let alice: OwnerScopedDatabaseProvider;
let bob: OwnerScopedDatabaseProvider;
let aliceProject: string;
let bobProject: string;
const pages = new Map<string, string>();

const exec = (sql: string, ...args: unknown[]) => base.sqlite.prepare(sql).run(...args);

async function run(projectId: string, time = T1): Promise<TestRun> {
  vi.setSystemTime(new Date(time));
  return base.testRuns.createAndEnqueue({
    projectId,
    configurationId: null,
    name: "Smoke",
    modules: ["links", "forms"],
    browsers: ["chromium", "firefox"],
    viewports: ["desktop-1440x900"],
    pageIds: [pages.get(projectId)!],
    configurationName: "Saved config",
    options: { allowFormSubmission: true, maxLinksPerPage: 25, navigationTimeoutMs: 5000 },
  });
}
function results(runId: string, ...statuses: string[]) {
  const projectId = (base.sqlite.prepare("SELECT project_id FROM test_runs WHERE id = ?").get(runId) as { project_id: string }).project_id;
  for (const status of statuses) {
    const caseId = randomUUID();
    exec("INSERT INTO test_cases (id, project_id, test_run_id, module, title) VALUES (?, ?, ?, 'links', 'case')", caseId, projectId, runId);
    const executedAt = ["PASS", "FAIL", "WARNING"].includes(status) ? T1 : null;
    exec("INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at) VALUES (?, ?, ?, ?, ?)", randomUUID(), runId, caseId, status, executedAt);
  }
}
const runRow = (id: string) => base.sqlite.prepare("SELECT status, cancel_requested, completed_at, updated_at FROM test_runs WHERE id = ?").get(id);
const jobStatus = (runId: string) =>
  (base.sqlite.prepare("SELECT status FROM jobs WHERE type = 'run.execute' AND json_extract(payload, '$.testRunId') = ?").get(runId) as { status: string } | undefined)?.status;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  base = createTestDb();
  aliceProject = (await base.projects.create(projectInput({ name: "Alice" }), "user-alice")).id;
  bobProject = (await base.projects.create(projectInput({ name: "Bob", websiteUrl: "https://bob.test/" }), "user-bob")).id;
  for (const p of [aliceProject, bobProject]) pages.set(p, (await base.pages.addManual(p, "https://x.test/", "https://x.test/")).page.id);
  alice = new OwnerScopedDatabaseProvider(base, "user-alice");
  bob = new OwnerScopedDatabaseProvider(base, "user-bob");
});
afterEach(async () => {
  vi.useRealTimers();
  await base.close();
});

describe("test runs repository: getDetail", () => {
  it("returns null for missing runs", async () => {
    expect(await base.testRuns.getDetail("no-such-run")).toBeNull();
    expect(await base.testRuns.getDetail("")).toBeNull();
  });

  it("returns the full detail of a new run, with zero counts", async () => {
    const r = await run(aliceProject);
    expect(await base.testRuns.getDetail(r.id)).toEqual({
      id: r.id,
      projectId: aliceProject,
      projectName: "Alice",
      name: "Smoke",
      status: "PENDING",
      configurationId: null,
      modules: ["links", "forms"],
      browsers: ["chromium", "firefox"],
      viewports: ["desktop-1440x900"],
      pageIds: [pages.get(aliceProject)],
      options: { allowFormSubmission: true, maxLinksPerPage: 25, navigationTimeoutMs: 5000 },
      progressTotal: 2,
      progressCompleted: 0,
      currentPageUrl: null,
      currentTest: null,
      cancelRequested: false,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: T1,
      counts: ZERO,
    });
  });

  it("reflects progress, results and cancellation, and falls back to defaults for missing snapshot data", async () => {
    const r = await run(aliceProject);
    exec(
      `UPDATE test_runs SET status = 'RUNNING', progress_completed = 1, current_page_url = 'https://x.test/', current_test = 'links',
         cancel_requested = 1, started_at = ?, error_message = 'boom', config_snapshot = '{}', options = 'not json', name = NULL WHERE id = ?`,
      T2,
      r.id,
    );
    results(r.id, "PASS", "PASS", "FAIL", "WARNING", "NOT EXECUTED", "NOT APPLICABLE", "NOT APPLICABLE");
    expect(await base.testRuns.getDetail(r.id)).toMatchObject({
      name: null,
      status: "RUNNING",
      modules: [],
      browsers: [],
      viewports: [],
      pageIds: [],
      options: { allowFormSubmission: false, maxLinksPerPage: 100, navigationTimeoutMs: 30_000 },
      progressTotal: 2,
      progressCompleted: 1,
      currentPageUrl: "https://x.test/",
      currentTest: "links",
      cancelRequested: true,
      errorMessage: "boom",
      startedAt: T2,
      counts: { PASS: 2, FAIL: 1, WARNING: 1, "NOT EXECUTED": 1, "NOT APPLICABLE": 2 },
    });
  });

  it("matches the synchronous helper used by reports", async () => {
    const r = await run(aliceProject);
    results(r.id, "PASS", "FAIL");
    expect(await base.testRuns.getDetail(r.id)).toEqual(runDetail(base.sqlite, r.id));
    expect(runDetail(base.sqlite, "missing")).toBeNull();
  });
});

describe("test runs repository: countsByRun", () => {
  it("returns an empty object for no ids, and zero counts for runs without results or unknown ids", async () => {
    expect(await base.testRuns.countsByRun([])).toEqual({});
    const r = await run(aliceProject);
    expect(await base.testRuns.countsByRun([r.id, "unknown"])).toEqual({ [r.id]: ZERO, unknown: ZERO });
  });

  it("counts each run's results by status, keyed in the order given, and tolerates duplicate ids", async () => {
    const a = await run(aliceProject);
    const b = await run(bobProject, T2);
    results(a.id, "PASS", "FAIL", "FAIL");
    results(b.id, "WARNING");
    const counts = await base.testRuns.countsByRun([b.id, a.id, b.id]);
    expect(Object.keys(counts)).toEqual([b.id, a.id]);
    expect(counts).toEqual({ [a.id]: { ...ZERO, PASS: 1, FAIL: 2 }, [b.id]: { ...ZERO, WARNING: 1 } });
    expect(counts).toEqual(countsFor(base.sqlite, [b.id, a.id, b.id])); // same as the helper used by history
  });
});

describe("test runs repository: requestCancel", () => {
  it("cancels a pending run and its queued job", async () => {
    const r = await run(aliceProject);
    expect(jobStatus(r.id)).toBe("PENDING");
    vi.setSystemTime(new Date(T2));
    expect(await base.testRuns.requestCancel(r.id)).toBe(true);
    expect(runRow(r.id)).toEqual({ status: "CANCELLED", cancel_requested: 1, completed_at: T2, updated_at: T2 });
    expect(jobStatus(r.id)).toBe("CANCELLED");
    expect(await base.testRuns.requestCancel(r.id)).toBe(false); // already cancelled
  });

  it("only flags a running run, and rejects finished and missing runs", async () => {
    const running = await run(aliceProject);
    exec("UPDATE test_runs SET status = 'RUNNING' WHERE id = ?", running.id);
    vi.setSystemTime(new Date(T2));
    expect(await base.testRuns.requestCancel(running.id)).toBe(true);
    expect(runRow(running.id)).toEqual({ status: "RUNNING", cancel_requested: 1, completed_at: null, updated_at: T2 });
    for (const status of ["COMPLETED", "FAILED"]) {
      const done = await run(aliceProject);
      exec("UPDATE test_runs SET status = ? WHERE id = ?", status, done.id);
      expect(await base.testRuns.requestCancel(done.id), status).toBe(false);
      expect(runRow(done.id)).toMatchObject({ status, cancel_requested: 0 });
    }
    expect(await base.testRuns.requestCancel("missing")).toBe(false);
  });
});

describe("test runs repository: ownership", () => {
  it("keeps detail, counts and cancellation isolated per owner", async () => {
    const a = await run(aliceProject);
    const b = await run(bobProject, T2);
    results(a.id, "FAIL");
    expect(await alice.testRuns.getDetail(a.id)).toEqual(await base.testRuns.getDetail(a.id));
    expect(await bob.testRuns.getDetail(a.id)).toBeNull();
    expect(await bob.testRuns.countsByRun([a.id, b.id])).toEqual({ [b.id]: ZERO });
    expect(await alice.testRuns.countsByRun([a.id, b.id])).toEqual({ [a.id]: { ...ZERO, FAIL: 1 } });
    expect(await bob.testRuns.requestCancel(a.id)).toBe(false);
    expect(runRow(a.id)).toMatchObject({ status: "PENDING", cancel_requested: 0 });
    expect(await alice.testRuns.requestCancel(a.id)).toBe(true);
  });
});

describe("test runs repository: behaviour snapshot", () => {
  it("produces the recorded behaviour snapshot", async () => {
    const out: Record<string, unknown> = { missing: await base.testRuns.getDetail("missing"), noIds: await base.testRuns.countsByRun([]) };
    const a = await run(aliceProject);
    const b = await run(bobProject, T2);
    results(a.id, "PASS", "FAIL", "NOT APPLICABLE");
    out.detailA = await base.testRuns.getDetail(a.id);
    out.detailB = await bob.testRuns.getDetail(b.id);
    out.counts = await base.testRuns.countsByRun([b.id, "unknown", a.id, b.id]);
    out.scopedCounts = await bob.testRuns.countsByRun([a.id, b.id]);
    out.bobCancelsA = await bob.testRuns.requestCancel(a.id);
    vi.setSystemTime(new Date(T2));
    out.cancelA = await base.testRuns.requestCancel(a.id);
    out.cancelAAgain = await base.testRuns.requestCancel(a.id);
    out.afterCancel = await base.testRuns.getDetail(a.id);
    if (process.env.QA_RUN_DETAIL_BEHAVIOUR_OUT) {
      // Ids are random per run; replace them so two runs can be compared byte for byte.
      let text = JSON.stringify(out, null, 2);
      for (const [id, name] of [[a.id, "<run-a>"], [b.id, "<run-b>"], [aliceProject, "<alice-project>"], [bobProject, "<bob-project>"], [pages.get(aliceProject)!, "<alice-page>"], [pages.get(bobProject)!, "<bob-page>"]]) text = text.replaceAll(id, name);
      fs.writeFileSync(process.env.QA_RUN_DETAIL_BEHAVIOUR_OUT, text);
    }
    expect(out.cancelA).toBe(true);
  });
});
