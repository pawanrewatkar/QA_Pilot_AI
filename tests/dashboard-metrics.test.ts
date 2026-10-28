import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import type { DashboardMetrics } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Dashboard metrics (`getMetrics`, in-memory SQLite only). Pins every count for mixed data from two owners plus
 * a legacy project without an owner, the owner filter (bound once per sub-count), and the all-zero result for an
 * empty database, so the method can move onto the SQL executor unchanged. Rows are seeded directly into the
 * in-memory test database.
 *
 * Set QA_METRICS_BEHAVIOUR_OUT to a file path to also write the observations as JSON (used to compare the
 * implementation before and after a refactor).
 */

const ZERO: DashboardMetrics = {
  totalProjects: 0,
  totalTestRuns: 0,
  totalPagesTested: 0,
  totalTestCases: 0,
  passed: 0,
  failed: 0,
  warnings: 0,
  notExecuted: 0,
  bugs: 0,
  openBugs: 0,
  criticalBugs: 0,
  highBugs: 0,
  mediumBugs: 0,
  lowBugs: 0,
};

let base: LocalDatabaseProvider;

const exec = (sql: string, ...args: unknown[]) => base.sqlite.prepare(sql).run(...args);

async function project(owner: string | null, name: string) {
  const id = (await base.projects.create(projectInput({ name, websiteUrl: `https://${name}.test/` }), owner ?? "temp")).id;
  if (owner === null) exec("UPDATE projects SET owner_id = NULL WHERE id = ?", id); // legacy row: visible to no owner
  return id;
}
function run(projectId: string) {
  const id = randomUUID();
  exec("INSERT INTO test_runs (id, project_id, status) VALUES (?, ?, 'COMPLETED')", id, projectId);
  return id;
}
async function page(projectId: string, path: string) {
  return (await base.pages.addManual(projectId, `https://x.test/${path}`, `https://x.test/${path}`)).page.id;
}
const runPage = (runId: string, pageId: string, status: string) => exec("INSERT INTO test_run_pages (id, test_run_id, page_id, status) VALUES (?, ?, ?, ?)", randomUUID(), runId, pageId, status);
function result(runId: string, status: string) {
  const projectId = (base.sqlite.prepare("SELECT project_id FROM test_runs WHERE id = ?").get(runId) as { project_id: string }).project_id;
  const caseId = randomUUID();
  exec("INSERT INTO test_cases (id, project_id, test_run_id, module, title) VALUES (?, ?, ?, 'links', 'case')", caseId, projectId, runId);
  const executedAt = ["PASS", "FAIL", "WARNING"].includes(status) ? "2026-03-01T00:00:00.000Z" : null;
  exec("INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at) VALUES (?, ?, ?, ?, ?)", randomUUID(), runId, caseId, status, executedAt);
}
const bug = (projectId: string, status: string, severity: string) => exec("INSERT INTO bugs (id, project_id, title, severity, status) VALUES (?, ?, 'bug', ?, ?)", randomUUID(), projectId, severity, status);

/** Two owners plus a legacy project without an owner (counted only when no owner filter is applied). */
async function seedMixed() {
  const a1 = await project("user-alice", "a1");
  const a2 = await project("user-alice", "a2");
  const b1 = await project("user-bob", "b1");
  const legacy = await project(null, "legacy");
  const [rA1a, rA1b, rA2, rB, rL] = [run(a1), run(a1), run(a2), run(b1), run(legacy)];
  const [pA1x, pA1y, pA2x, pBx, pLx] = [await page(a1, "x"), await page(a1, "y"), await page(a2, "x"), await page(b1, "x"), await page(legacy, "x")];
  runPage(rA1a, pA1x, "COMPLETED");
  runPage(rA1b, pA1x, "COMPLETED"); // same page completed twice: counted once
  runPage(rA1b, pA1y, "FAILED"); // not completed: not counted
  runPage(rA2, pA2x, "COMPLETED");
  runPage(rB, pBx, "COMPLETED");
  runPage(rL, pLx, "COMPLETED");
  for (const s of ["PASS", "PASS", "FAIL", "WARNING", "NOT EXECUTED", "NOT APPLICABLE"]) result(rA1a, s);
  for (const s of ["FAIL", "FAIL", "NOT EXECUTED"]) result(rB, s);
  result(rL, "PASS");
  for (const [s, sev] of [["OPEN", "CRITICAL"], ["REOPENED", "HIGH"], ["IN_PROGRESS", "MEDIUM"], ["RESOLVED", "LOW"], ["CLOSED", "HIGH"]]) bug(a1, s, sev);
  bug(b1, "WONT_FIX", "LOW");
  bug(b1, "OPEN", "LOW");
  bug(legacy, "OPEN", "CRITICAL");
}

const ALICE: DashboardMetrics = { totalProjects: 2, totalTestRuns: 3, totalPagesTested: 2, totalTestCases: 6, passed: 2, failed: 1, warnings: 1, notExecuted: 1, bugs: 5, openBugs: 3, criticalBugs: 1, highBugs: 2, mediumBugs: 1, lowBugs: 1 };
const BOB: DashboardMetrics = { totalProjects: 1, totalTestRuns: 1, totalPagesTested: 1, totalTestCases: 3, passed: 0, failed: 2, warnings: 0, notExecuted: 1, bugs: 2, openBugs: 1, criticalBugs: 0, highBugs: 0, mediumBugs: 0, lowBugs: 2 };
const LEGACY: DashboardMetrics = { totalProjects: 1, totalTestRuns: 1, totalPagesTested: 1, totalTestCases: 1, passed: 1, failed: 0, warnings: 0, notExecuted: 0, bugs: 1, openBugs: 1, criticalBugs: 1, highBugs: 0, mediumBugs: 0, lowBugs: 0 };
const ALL = Object.fromEntries(Object.keys(ZERO).map((k) => [k, ALICE[k as keyof DashboardMetrics] + BOB[k as keyof DashboardMetrics] + LEGACY[k as keyof DashboardMetrics]])) as unknown as DashboardMetrics;

/**
 * Records the SQL text and bound arguments of the metrics query, at the better-sqlite3 level. Every statement
 * (direct or through the SQL executor) is created by `prepare`, so this works for either implementation.
 */
function captureMetricsBindings() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = base.sqlite.prepare.bind(base.sqlite);
  vi.spyOn(base.sqlite, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (!sql.includes("AS total_projects")) return stmt;
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "get") return (...args: unknown[]) => (calls.push({ sql, args }), target.get(...args));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof base.sqlite.prepare);
  return calls;
}
const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

beforeEach(() => {
  base = createTestDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await base.close();
});

describe("dashboard metrics", () => {
  it("returns all zeros for an empty database, with and without an owner", async () => {
    expect(await base.dashboard.getMetrics()).toEqual(ZERO);
    expect(await base.dashboard.getMetrics("user-alice")).toEqual(ZERO);
    expect(await new OwnerScopedDatabaseProvider(base, "user-alice").dashboard.getMetrics()).toEqual(ZERO);
  });

  it("counts everything, including unowned legacy data, when no owner filter is applied", async () => {
    await seedMixed();
    expect(await base.dashboard.getMetrics()).toEqual(ALL);
  });

  it("restricts every count to the owner's data, with no cross-owner leakage", async () => {
    await seedMixed();
    expect(await base.dashboard.getMetrics("user-alice")).toEqual(ALICE);
    expect(await base.dashboard.getMetrics("user-bob")).toEqual(BOB);
    expect(await new OwnerScopedDatabaseProvider(base, "user-alice").dashboard.getMetrics()).toEqual(ALICE);
    expect(await new OwnerScopedDatabaseProvider(base, "user-bob").dashboard.getMetrics()).toEqual(BOB);
    // Unknown and empty owners see nothing; legacy rows without an owner are never attributed to anyone.
    expect(await base.dashboard.getMetrics("user-nobody")).toEqual(ZERO);
    expect(await base.dashboard.getMetrics("")).toEqual(ZERO);
  });

  it("binds the owner id exactly 14 times when filtering, and nothing otherwise", async () => {
    await seedMixed();
    const calls = captureMetricsBindings();
    await base.dashboard.getMetrics("user-alice");
    await base.dashboard.getMetrics();
    await base.dashboard.getMetrics("");
    expect(calls).toHaveLength(3);
    const [scoped, unscoped, empty] = calls;
    expect(scoped.args).toEqual(Array(14).fill("user-alice"));
    expect(placeholders(scoped.sql)).toBe(14); // one placeholder per bound value
    expect(unscoped.args).toEqual([]);
    expect(placeholders(unscoped.sql)).toBe(0);
    expect(empty.args).toEqual(Array(14).fill("")); // "" is still an owner filter (matches nothing)
  });

  it("returns numbers for every metric", async () => {
    await seedMixed();
    for (const value of Object.values(await base.dashboard.getMetrics("user-alice"))) expect(typeof value).toBe("number");
    expect(Object.keys(await base.dashboard.getMetrics()).sort()).toEqual(Object.keys(ZERO).sort());
  });

  it("produces the recorded behaviour snapshot", async () => {
    // Capture before the first call: the SQL executor caches prepared statements, so a statement created before
    // the capture is installed would be reused without being recorded.
    const calls = captureMetricsBindings();
    const out: Record<string, unknown> = { emptyAll: await base.dashboard.getMetrics(), emptyAlice: await base.dashboard.getMetrics("user-alice") };
    await seedMixed();
    out.all = await base.dashboard.getMetrics();
    out.alice = await base.dashboard.getMetrics("user-alice");
    out.bob = await base.dashboard.getMetrics("user-bob");
    out.nobody = await base.dashboard.getMetrics("user-nobody");
    out.emptyOwner = await base.dashboard.getMetrics("");
    out.bindings = calls.map((c) => ({ placeholders: placeholders(c.sql), args: c.args }));
    out.sql = [...new Set(calls.map((c) => c.sql.replace(/\s+/g, " ").trim()))];
    if (process.env.QA_METRICS_BEHAVIOUR_OUT) fs.writeFileSync(process.env.QA_METRICS_BEHAVIOUR_OUT, JSON.stringify(out, null, 2));
    expect(out.alice).toEqual(ALICE);
  });
});
