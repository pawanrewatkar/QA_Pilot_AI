import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import type { HistoryQuery, RunHistoryRecord, TestRunStatus } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Run history: `listRuns` (in-memory SQLite only). Pins filtering (same helper as `countRuns`), the bound values,
 * ordering (newest first, insertion order breaking ties), pagination and its clamping, the full mapping of a run
 * (counts, pages, bugs, severity, performance, module ratios) and ownership, so the method can move onto the SQL
 * executor unchanged. Rows are seeded directly, with fixed ids.
 *
 * Set QA_HISTORY_LIST_BEHAVIOUR_OUT to a file path to also write the observations as JSON (used to compare the
 * implementation before and after a refactor).
 */

const T = (n: number) => `2026-03-0${n}T10:00:00.000Z`;
const ZERO = { PASS: 0, FAIL: 0, WARNING: 0, "NOT EXECUTED": 0, "NOT APPLICABLE": 0 };
const NO_SEVERITY = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };

let base: LocalDatabaseProvider;
let n = 0;

const exec = (sql: string, ...args: unknown[]) => base.sqlite.prepare(sql).run(...args);
const nextId = (prefix: string) => `${prefix}-${String(++n).padStart(3, "0")}`;

async function project(owner: string | null, slug: string, name: string) {
  const id = `project-${slug}`;
  // Renamed before anything references it.
  exec("UPDATE projects SET id = ? WHERE id = ?", id, (await base.projects.create(projectInput({ name, websiteUrl: `https://${slug}.test/` }), owner ?? "temp")).id);
  if (owner === null) exec("UPDATE projects SET owner_id = NULL WHERE id = ?", id); // legacy row: visible to no owner
  return id;
}
function run(projectId: string, id: string, createdAt: string, status: TestRunStatus, name: string | null, extra: { runType?: string; completedAt?: string } = {}) {
  exec(
    "INSERT INTO test_runs (id, project_id, status, name, created_at, completed_at, run_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    projectId,
    status,
    name,
    createdAt,
    extra.completedAt ?? null,
    extra.runType ?? "WEBSITE",
  );
}
function result(runId: string, module: string, status: string) {
  const projectId = (base.sqlite.prepare("SELECT project_id FROM test_runs WHERE id = ?").get(runId) as { project_id: string }).project_id;
  const caseId = nextId("case");
  exec("INSERT INTO test_cases (id, project_id, test_run_id, module, title) VALUES (?, ?, ?, ?, 'case')", caseId, projectId, runId, module);
  const resultId = nextId("result");
  exec("INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at) VALUES (?, ?, ?, ?, ?)", resultId, runId, caseId, status, ["PASS", "FAIL", "WARNING"].includes(status) ? T(1) : null);
  return resultId;
}

/** Alice: two projects; Bob: one; plus a legacy project without an owner. Run r1 carries data for every mapped field. */
async function seed() {
  const alpha = await project("user-alice", "alpha", "Alpha Shop");
  const beta = await project("user-alice", "beta", "Beta_Blog");
  const gamma = await project("user-bob", "gamma", "Gamma");
  const legacy = await project(null, "legacy", "Legacy");
  run(alpha, "r1", T(1), "COMPLETED", "Release 1.0", { completedAt: T(2) });
  run(alpha, "r2", T(2), "FAILED", "Nightly");
  // r4 is inserted before r3 with the same timestamp: insertion order (not id order) decides, so r3 comes first.
  run(alpha, "r4", T(3), "COMPLETED", "50% rollout");
  run(alpha, "r3", T(3), "RUNNING", null, { runType: "EXTERNAL_TEST_CASE" });
  run(beta, "r5", T(4), "COMPLETED", "Release 2.0");
  run(beta, "r6", T(5), "CANCELLED", "smoke_test");
  run(gamma, "r7", T(6), "COMPLETED", "Release 1.0");
  run(gamma, "r8", T(7), "PENDING", "Nightly");
  run(legacy, "r9", T(8), "COMPLETED", "Release old");

  // r1: two pages, five results across modules, two bugs (one first seen here), three performance measurements.
  for (const path of ["a", "b"]) {
    const pageId = (await base.pages.addManual(alpha, `https://alpha.test/${path}`, `https://alpha.test/${path}`)).page.id;
    exec("INSERT INTO test_run_pages (id, test_run_id, page_id, status) VALUES (?, 'r1', ?, 'COMPLETED')", nextId("trp"), pageId);
  }
  const fail1 = result("r1", "accessibility", "FAIL");
  result("r1", "accessibility", "PASS");
  result("r1", "accessibility", "NOT EXECUTED");
  result("r1", "seo", "PASS");
  const fail2 = result("r1", "links", "FAIL");
  exec("INSERT INTO bugs (id, project_id, title, severity, first_seen_run_id) VALUES ('bug-high', ?, 'High', 'HIGH', 'r1')", alpha);
  exec("INSERT INTO bugs (id, project_id, title, severity) VALUES ('bug-critical', ?, 'Critical', 'CRITICAL')", alpha);
  for (const [bug, res] of [["bug-high", fail1], ["bug-high", fail2], ["bug-critical", fail2]]) {
    exec("INSERT INTO bug_occurrences (id, bug_id, test_run_id, test_result_id, observed_at) VALUES (?, ?, 'r1', ?, ?)", nextId("occ"), bug, res, T(1));
  }
  for (const [score, lcp] of [[0.5, 1000], [0.75, 2000], [null, null]]) {
    exec("INSERT INTO performance_results (id, test_run_id, source, performance_score, lcp_ms, measured_at) VALUES (?, 'r1', 'LOCAL_BROWSER', ?, ?, ?)", nextId("perf"), score, lcp, T(1));
  }
}

const ORDER = ["r9", "r8", "r7", "r6", "r5", "r3", "r4", "r2", "r1"];
const ids = (rows: RunHistoryRecord[]) => rows.map((r) => r.id);

/** Filters and their expected run ids (in returned order). */
const FILTERS: [string, HistoryQuery, string[]][] = [
  ["all", {}, ORDER],
  ["project", { projectId: "project-alpha" }, ["r3", "r4", "r2", "r1"]],
  ["unknown project", { projectId: "project-none" }, []],
  ["empty project id (ignored)", { projectId: "" }, ORDER],
  ["status", { status: "COMPLETED" }, ["r9", "r7", "r5", "r4", "r1"]],
  ["owner alice", { ownerId: "user-alice" }, ["r6", "r5", "r3", "r4", "r2", "r1"]],
  ["owner bob", { ownerId: "user-bob" }, ["r8", "r7"]],
  ["unknown owner", { ownerId: "user-nobody" }, []],
  ["empty owner (matches nothing)", { ownerId: "" }, []],
  ["search run name", { search: "Release" }, ["r9", "r7", "r5", "r1"]],
  ["search is case-insensitive (ASCII) and trimmed", { search: "  release " }, ["r9", "r7", "r5", "r1"]],
  ["search % is literal", { search: "%" }, ["r4"]],
  ["search _ is literal", { search: "_" }, ["r6", "r5"]],
  ["search website", { search: "gamma.test" }, ["r8", "r7"]],
  ["search no match", { search: "nothing-matches" }, []],
  ["owner + status", { ownerId: "user-alice", status: "COMPLETED" }, ["r5", "r4", "r1"]],
  ["project + other owner", { projectId: "project-alpha", ownerId: "user-bob" }, []],
  ["all filters", { projectId: "project-gamma", ownerId: "user-bob", status: "PENDING", search: "Nightly" }, ["r8"]],
];

/** Records the SQL text and bound arguments of the list query at the better-sqlite3 level (old and new code). */
function captureBindings() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = base.sqlite.prepare.bind(base.sqlite);
  vi.spyOn(base.sqlite, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (!sql.includes("ORDER BY r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?")) return stmt;
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "all") return (...args: unknown[]) => (calls.push({ sql, args }), target.all(...args));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof base.sqlite.prepare);
  return calls;
}
const outcome = async (q: HistoryQuery) =>
  base.history.listRuns(q).then(
    (rows) => ids(rows),
    (e: Error) => `${e.name}: ${e.message}`,
  );

beforeEach(() => {
  n = 0;
  base = createTestDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await base.close();
});

describe("run history: listRuns", () => {
  it("returns an empty list for an empty database", async () => {
    expect(await base.history.listRuns()).toEqual([]);
    expect(await base.history.listRuns({ ownerId: "user-alice", status: "COMPLETED", search: "x", limit: 5, offset: 2 })).toEqual([]);
    expect(await new OwnerScopedDatabaseProvider(base, "user-alice").history.listRuns()).toEqual([]);
  });

  it("maps every field of a run, including counts, bugs, performance and module ratios", async () => {
    await seed();
    const rows = await base.history.listRuns();
    expect(rows.find((r) => r.id === "r1")).toEqual({
      id: "r1",
      name: "Release 1.0",
      runType: "WEBSITE",
      projectId: "project-alpha",
      projectName: "Alpha Shop",
      website: "https://alpha.test/",
      status: "COMPLETED",
      createdAt: T(1),
      completedAt: T(2),
      pages: 2,
      totalTests: 5,
      counts: { ...ZERO, PASS: 2, FAIL: 2, "NOT EXECUTED": 1 },
      bugs: 2, // distinct bugs seen in the run
      newBugs: 1, // first seen in this run
      severity: { ...NO_SEVERITY, CRITICAL: 1, HIGH: 1 },
      performanceScore: 0.625, // average of measured pages, ignoring missing scores
      lcpMs: 1500,
      accessibility: { failed: 1, executed: 2 }, // NOT EXECUTED is not executed
      seo: { failed: 0, executed: 1 },
    });
  });

  it("maps a run without any data to zeros and nulls", async () => {
    await seed();
    const rows = await base.history.listRuns();
    expect(rows.find((r) => r.id === "r3")).toEqual({
      id: "r3",
      name: null,
      runType: "EXTERNAL_TEST_CASE",
      projectId: "project-alpha",
      projectName: "Alpha Shop",
      website: "https://alpha.test/",
      status: "RUNNING",
      createdAt: T(3),
      completedAt: null,
      pages: 0,
      totalTests: 0,
      counts: ZERO,
      bugs: 0,
      newBugs: 0,
      severity: NO_SEVERITY,
      performanceScore: null,
      lcpMs: null,
      accessibility: null,
      seo: null,
    });
  });

  it("orders newest first, breaking ties by insertion order", async () => {
    await seed();
    expect(ids(await base.history.listRuns())).toEqual(ORDER);
  });

  it("returns the runs matching each filter and combination", async () => {
    await seed();
    for (const [label, query, expected] of FILTERS) expect(ids(await base.history.listRuns(query)), label).toEqual(expected);
  });

  it("paginates and clamps limit and offset exactly as before", async () => {
    await seed();
    const page = async (q: HistoryQuery) => ids(await base.history.listRuns(q));
    expect(await page({ limit: 2 })).toEqual(["r9", "r8"]);
    expect(await page({ limit: 2, offset: 2 })).toEqual(["r7", "r6"]);
    expect(await page({ limit: 2, offset: 8 })).toEqual(["r1"]);
    expect(await page({ offset: 100 })).toEqual([]);
    expect(await page({ limit: 3, offset: 1, ownerId: "user-alice" })).toEqual(["r5", "r3", "r4"]);
    // Existing clamping: limit defaults to 25 and is kept within 1..200; a negative offset is treated as 0.
    expect(await page({})).toHaveLength(9);
    expect(await page({ limit: 0 })).toEqual(["r9"]);
    expect(await page({ limit: -5 })).toEqual(["r9"]);
    expect(await page({ limit: 500 })).toHaveLength(9);
    expect(await page({ limit: 2, offset: -3 })).toEqual(["r9", "r8"]);
  });

  it("binds the filters, then the limit and offset", async () => {
    await seed();
    const calls = captureBindings();
    await base.history.listRuns({ search: " 5%_\\ ", status: "COMPLETED", ownerId: "user-alice", projectId: "project-alpha", limit: 7, offset: 3 });
    await base.history.listRuns();
    await base.history.listRuns({ ownerId: "", limit: 1000, offset: -1 });
    const p = "%5\\%\\_\\\\%";
    expect(calls.map((c) => c.args)).toEqual([["project-alpha", "user-alice", "COMPLETED", p, p, p, 7, 3], [25, 0], ["", 200, 0]]);
    expect(calls.map((c) => (c.sql.match(/\?/g) ?? []).length)).toEqual([8, 2, 3]);
  });

  it("keeps runs isolated per owner through the scoped provider", async () => {
    await seed();
    const alice = new OwnerScopedDatabaseProvider(base, "user-alice");
    const bob = new OwnerScopedDatabaseProvider(base, "user-bob");
    expect(await alice.history.listRuns()).toEqual(await base.history.listRuns({ ownerId: "user-alice" }));
    expect(ids(await bob.history.listRuns())).toEqual(["r8", "r7"]);
    expect(await alice.history.listRuns({ projectId: "project-gamma" })).toEqual([]); // another owner's project
    expect(ids(await alice.history.listRuns({ ownerId: "user-bob" }))).toEqual(["r6", "r5", "r3", "r4", "r2", "r1"]); // caller owner id replaced
    expect(await bob.history.countRuns()).toBe((await bob.history.listRuns()).length);
  });

  it("is wired to the provider's connection and SQL executor", () => {
    expect(Reflect.get(base.history, "db")).toBe(base.sqlite);
    expect(Reflect.get(base.history, "sql")).toBe(base.sql);
  });

  it("produces the recorded behaviour snapshot", async () => {
    const calls = captureBindings();
    const out: Record<string, unknown> = { empty: await base.history.listRuns() };
    await seed();
    out.all = await base.history.listRuns();
    out.filters = Object.fromEntries(await Promise.all(FILTERS.map(async ([label, query]) => [label, ids(await base.history.listRuns(query))] as const)));
    // Values the clamping does not normalise are passed to SQLite as they are; record whatever happens.
    out.edges = {
      limitFraction: await outcome({ limit: 2.5 }),
      limitNaN: await outcome({ limit: Number.NaN }),
      offsetFraction: await outcome({ limit: 2, offset: 1.5 }),
      offsetNaN: await outcome({ limit: 2, offset: Number.NaN }),
    };
    out.scoped = { alice: ids(await new OwnerScopedDatabaseProvider(base, "user-alice").history.listRuns()), bob: ids(await new OwnerScopedDatabaseProvider(base, "user-bob").history.listRuns()) };
    out.bindings = calls.map((c) => c.args.map((a) => (typeof a === "number" ? `number:${a}` : a)));
    out.sql = [...new Set(calls.map((c) => c.sql))];
    if (process.env.QA_HISTORY_LIST_BEHAVIOUR_OUT) fs.writeFileSync(process.env.QA_HISTORY_LIST_BEHAVIOUR_OUT, JSON.stringify(out, null, 2));
    expect(ids(out.all as RunHistoryRecord[])).toEqual(ORDER);
  });
});
