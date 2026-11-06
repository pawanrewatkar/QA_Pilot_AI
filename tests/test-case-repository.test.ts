import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import type { TestCaseRecord } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Test cases repository: `list` (in-memory SQLite only). Pins every returned field, the per-case result summary built
 * with SQLite JSON functions, ordering (including NULL codes), filtering by project, run and owner, and the limit, so
 * the method can move onto the SQL executor unchanged. Rows are seeded directly, with fixed ids, so the behaviour
 * snapshot is stable between test runs.
 *
 * Set QA_CASES_BEHAVIOUR_OUT to a file path to also write the observations as JSON (used to compare the
 * implementation before and after a refactor).
 */

const T = (day: number) => `2026-03-0${day}T10:00:00.000Z`;

let base: LocalDatabaseProvider;
let results = 0;

const exec = (sql: string, ...args: unknown[]) => base.sqlite.prepare(sql).run(...args);

async function project(owner: string | null, name: string) {
  const id = `project-${name}`;
  // Renamed before anything references it.
  exec("UPDATE projects SET id = ? WHERE id = ?", id, (await base.projects.create(projectInput({ name, websiteUrl: `https://${name}.test/` }), owner ?? "temp")).id);
  if (owner === null) exec("UPDATE projects SET owner_id = NULL WHERE id = ?", id); // legacy row: visible to no owner
  return id;
}
function run(projectId: string, id: string, createdAt: string) {
  exec("INSERT INTO test_runs (id, project_id, status, created_at) VALUES (?, ?, 'COMPLETED', ?)", id, projectId, createdAt);
  return id;
}
function testCase(id: string, projectId: string, runId: string | null, createdAt: string, code: string | null, extra: Record<string, unknown> = {}) {
  const cols = { id, project_id: projectId, test_run_id: runId, module: "links", title: `Case ${id}`, created_at: createdAt, code, ...extra };
  exec(`INSERT INTO test_cases (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`, ...Object.values(cols));
  return id;
}
function result(caseId: string, status: string) {
  const runId = (base.sqlite.prepare("SELECT test_run_id FROM test_cases WHERE id = ?").get(caseId) as { test_run_id: string }).test_run_id;
  const executedAt = ["PASS", "FAIL", "WARNING"].includes(status) ? T(5) : null;
  exec("INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at) VALUES (?, ?, ?, ?, ?)", `result-${++results}`, runId, caseId, status, executedAt);
}

/** Alice: two projects (one with two runs); Bob: one project; plus a legacy project without an owner. */
async function seed() {
  const a1 = await project("user-alice", "a1");
  const a2 = await project("user-alice", "a2");
  const b = await project("user-bob", "b");
  const legacy = await project(null, "legacy");
  const [rA1a, rA1b, rA2, rB, rL] = [run(a1, "run-a1a", T(1)), run(a1, "run-a1b", T(2)), run(a2, "run-a2", T(3)), run(b, "run-b", T(4)), run(legacy, "run-legacy", T(1))];
  testCase("c1", a1, rA1a, T(2), "TC-002", {
    module: "forms",
    priority: "P1",
    source: "MANUAL",
    page_url: "https://a1.test/contact",
    section: "Contact",
    scenario_type: "NEGATIVE",
    feature: "Contact form",
    element: "Submit button",
    preconditions: "Logged out",
    test_data: "email=x",
    steps: JSON.stringify(["Open the page", "Submit empty form"]),
    expected_result: "Validation errors are shown",
  });
  for (const s of ["PASS", "FAIL", "PASS", "NOT EXECUTED", "WARNING", "NOT APPLICABLE"]) result("c1", s);
  testCase("c2", a1, rA1a, T(2), "TC-001");
  result("c2", "FAIL");
  testCase("c3", a1, rA1b, T(2), null); // NULL code sorts first among equal timestamps
  testCase("c4", a1, null, T(1), null, { steps: "not json" }); // no run, unparseable steps, no results
  testCase("c5", a2, rA2, T(3), "TC-001");
  result("c5", "PASS");
  testCase("c6", b, rB, T(4), "TC-001");
  result("c6", "FAIL");
  testCase("c7", legacy, rL, T(1), "L-1");
  result("c7", "PASS");
}

const ids = (rows: TestCaseRecord[]) => rows.map((r) => r.id);

beforeEach(() => {
  results = 0;
  base = createTestDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await base.close();
});

describe("test cases repository: list", () => {
  it("returns an empty list when there are no test cases", async () => {
    expect(await base.testCases.list()).toEqual([]);
    expect(await base.testCases.list({ ownerId: "user-alice" })).toEqual([]);
    expect(await new OwnerScopedDatabaseProvider(base, "user-alice").testCases.list()).toEqual([]);
    await project("user-alice", "a1");
    expect(await base.testCases.list({ projectId: "project-a1" })).toEqual([]);
  });

  it("returns every field, with the result summary as parsed JSON objects", async () => {
    await seed();
    const rows = await base.testCases.list();
    expect(rows.find((r) => r.id === "c1")).toEqual({
      id: "c1",
      projectId: "project-a1",
      projectName: "a1",
      testRunId: "run-a1a",
      module: "forms",
      title: "Case c1",
      priority: "P1",
      source: "MANUAL",
      createdAt: T(2),
      code: "TC-002",
      pageUrl: "https://a1.test/contact",
      section: "Contact",
      scenarioType: "NEGATIVE",
      feature: "Contact form",
      element: "Submit button",
      preconditions: "Logged out",
      testData: "email=x",
      steps: ["Open the page", "Submit empty form"],
      expectedResult: "Validation errors are shown",
      // One object per status, grouped by status (SQLite returns the groups in status order).
      resultSummary: [
        { status: "FAIL", count: 1 },
        { status: "NOT APPLICABLE", count: 1 },
        { status: "NOT EXECUTED", count: 1 },
        { status: "PASS", count: 2 },
        { status: "WARNING", count: 1 },
      ],
    });
    for (const s of rows.find((r) => r.id === "c1")!.resultSummary) expect(typeof s.count).toBe("number");
    expect(rows.find((r) => r.id === "c2")!.resultSummary).toEqual([{ status: "FAIL", count: 1 }]);
  });

  it("uses nulls and defaults for missing values, and an empty summary for cases never executed", async () => {
    await seed();
    expect((await base.testCases.list()).find((r) => r.id === "c4")).toEqual({
      id: "c4",
      projectId: "project-a1",
      projectName: "a1",
      testRunId: null,
      module: "links",
      title: "Case c4",
      priority: null,
      source: "RULE",
      createdAt: T(1),
      code: null,
      pageUrl: null,
      section: null,
      scenarioType: null,
      feature: null,
      element: null,
      preconditions: null,
      testData: null,
      steps: [], // unparseable JSON falls back to []
      expectedResult: null,
      resultSummary: [],
    });
  });

  it("orders newest run first, then by test case ID (TC-001 first); cases without a run last", async () => {
    await seed();
    expect(ids(await base.testCases.list())).toEqual(["c6", "c5", "c3", "c2", "c1", "c7", "c4"]);
  });

  it("filters by project, run and owner, with no cross-owner leakage", async () => {
    await seed();
    expect(ids(await base.testCases.list({ projectId: "project-a1" }))).toEqual(["c3", "c2", "c1", "c4"]);
    expect(ids(await base.testCases.list({ testRunId: "run-a1a" }))).toEqual(["c2", "c1"]);
    expect(ids(await base.testCases.list({ projectId: "project-a1", testRunId: "run-a1b" }))).toEqual(["c3"]);
    expect(ids(await base.testCases.list({ projectId: "project-a1", testRunId: "run-b" }))).toEqual([]);
    expect(ids(await base.testCases.list({ ownerId: "user-alice" }))).toEqual(["c5", "c3", "c2", "c1", "c4"]);
    expect(ids(await base.testCases.list({ ownerId: "user-bob" }))).toEqual(["c6"]);
    expect(ids(await base.testCases.list({ projectId: "project-a1", ownerId: "user-bob" }))).toEqual([]);
    expect(ids(await base.testCases.list({ testRunId: "run-b", ownerId: "user-alice" }))).toEqual([]);
    expect(await base.testCases.list({ ownerId: "user-nobody" })).toEqual([]);
    expect(await base.testCases.list({ ownerId: "" })).toEqual([]); // an empty owner matches nothing
    // Existing edge cases: empty project and run ids are ignored.
    expect(ids(await base.testCases.list({ projectId: "", testRunId: "" }))).toHaveLength(7);
  });

  it("keeps test cases isolated per owner through the scoped provider", async () => {
    await seed();
    const alice = new OwnerScopedDatabaseProvider(base, "user-alice");
    const bob = new OwnerScopedDatabaseProvider(base, "user-bob");
    expect(await alice.testCases.list()).toEqual(await base.testCases.list({ ownerId: "user-alice" }));
    expect(ids(await bob.testCases.list())).toEqual(["c6"]);
    expect(await bob.testCases.list({ projectId: "project-a1" })).toEqual([]);
    expect(await bob.testCases.list({ testRunId: "run-a1a" })).toEqual([]);
  });

  it("applies the limit exactly as before", async () => {
    await seed();
    expect(ids(await base.testCases.list({ limit: 2 }))).toEqual(["c6", "c5"]);
    expect(ids(await base.testCases.list({ limit: 1.9 }))).toEqual(["c6"]);
    for (const limit of [0, -1, Number.NaN, 6000]) expect(await base.testCases.list({ limit }), String(limit)).toHaveLength(7);
    expect(ids(await base.testCases.list({ limit: 1, ownerId: "user-alice" }))).toEqual(["c5"]);
  });

  it("produces the recorded behaviour snapshot", async () => {
    const out: Record<string, unknown> = { empty: await base.testCases.list() };
    await seed();
    out.all = await base.testCases.list();
    out.project = await base.testCases.list({ projectId: "project-a1" });
    out.run = await base.testCases.list({ testRunId: "run-a1a" });
    out.alice = await base.testCases.list({ ownerId: "user-alice" });
    out.bob = await base.testCases.list({ ownerId: "user-bob" });
    out.emptyOwner = await base.testCases.list({ ownerId: "" });
    out.crossOwner = await base.testCases.list({ projectId: "project-a1", ownerId: "user-bob" });
    out.limit2 = await base.testCases.list({ limit: 2 });
    out.limit0 = ids(await base.testCases.list({ limit: 0 }));
    out.scopedAlice = await new OwnerScopedDatabaseProvider(base, "user-alice").testCases.list();
    if (process.env.QA_CASES_BEHAVIOUR_OUT) fs.writeFileSync(process.env.QA_CASES_BEHAVIOUR_OUT, JSON.stringify(out, null, 2));
    expect(out.scopedAlice).toEqual(out.alice);
  });
});
