import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import type { RegressionRecord } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Dashboard regressions (`getRegressions`, in-memory SQLite only). Pins which two completed runs are compared per
 * project (including ties on the completion time, broken by insertion order), how test cases are matched across
 * them, the limit, and owner filtering, so the method can move onto the SQL executor unchanged. Rows are seeded
 * directly into the in-memory test database.
 *
 * The query has no ORDER BY, so assertions compare sorted rows; the behaviour snapshot keeps the returned order.
 * Set QA_REGRESSIONS_BEHAVIOUR_OUT to a file path to also write the observations as JSON (used to compare the
 * implementation before and after a refactor).
 */

const T = (day: number) => `2026-03-${String(day).padStart(2, "0")}T10:00:00.000Z`;

let base: LocalDatabaseProvider;
/** Test labels for the random project, run and case ids. */
const labels = new Map<string, string>();
let cases = 0;

const exec = (sql: string, ...args: unknown[]) => base.sqlite.prepare(sql).run(...args);

/**
 * Ids are fixed (not random) because the query has no ORDER BY: the returned order follows the ids, so random ids
 * would make the order, and the behaviour snapshot, differ from one test run to the next.
 */
async function project(owner: string | null, name: string) {
  const id = `project-${name}`;
  // Renamed before anything references it.
  exec("UPDATE projects SET id = ? WHERE id = ?", id, (await base.projects.create(projectInput({ name, websiteUrl: `https://${name}.test/` }), owner ?? "temp")).id);
  if (owner === null) exec("UPDATE projects SET owner_id = NULL WHERE id = ?", id); // legacy row: visible to no owner
  labels.set(id, name);
  return id;
}
/** Inserted in call order, so `rowid` follows call order. `id` lets a test choose ids that sort against that order. */
function run(projectId: string, label: string, opts: { status?: string; completedAt?: string | null; createdAt?: string; id?: string } = {}) {
  const id = opts.id ?? `run-${label}`;
  exec(
    "INSERT INTO test_runs (id, project_id, status, completed_at, created_at) VALUES (?, ?, ?, ?, ?)",
    id,
    projectId,
    opts.status ?? "COMPLETED",
    opts.completedAt === undefined ? T(1) : opts.completedAt,
    opts.createdAt ?? T(1),
  );
  labels.set(id, label);
  return id;
}
async function page(projectId: string, path: string) {
  return (await base.pages.addManual(projectId, `https://x.test/${path}`, `https://x.test/${path}`)).page.id;
}
/** A test case in `runId` with one result. */
function result(runId: string, title: string, status: string, opts: { module?: string; pageId?: string | null } = {}) {
  const projectId = (base.sqlite.prepare("SELECT project_id FROM test_runs WHERE id = ?").get(runId) as { project_id: string }).project_id;
  const caseId = `case-${String(++cases).padStart(3, "0")}`;
  exec("INSERT INTO test_cases (id, project_id, test_run_id, page_id, module, title) VALUES (?, ?, ?, ?, ?, ?)", caseId, projectId, runId, opts.pageId ?? null, opts.module ?? "links", title);
  exec("INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at) VALUES (?, ?, ?, ?, ?)", `result-${caseId}`, runId, caseId, status, T(1));
  labels.set(caseId, `${labels.get(runId)}:${title}`);
}

/**
 * Alice: a project with no completed run, one with a single completed run, one with exactly two (every case
 * pairing), one with more than two, and one whose runs tie on the completion time. Bob: one project with exactly two
 * runs. Legacy: a project without an owner (only seen when no owner filter is applied).
 */
async function seed() {
  // No completed run at all.
  const zero = await project("user-alice", "zero");
  result(run(zero, "zero-running", { status: "RUNNING", completedAt: null }), "z", "FAIL");

  // A single completed run; newer runs that did not complete are not candidates.
  const one = await project("user-alice", "one");
  result(run(one, "one-done", { completedAt: T(1) }), "x", "PASS");
  result(run(one, "one-failed", { status: "FAILED", completedAt: T(2), createdAt: T(2) }), "x", "FAIL");
  result(run(one, "one-cancelled", { status: "CANCELLED", completedAt: T(3), createdAt: T(3) }), "x", "FAIL");

  // Exactly two completed runs.
  const two = await project("user-alice", "two");
  const [px, py] = [await page(two, "x"), await page(two, "y")];
  const prev = run(two, "two-prev", { completedAt: T(1) });
  const latest = run(two, "two-latest", { completedAt: T(2) });
  for (const [title, before, after] of [
    ["pass-fail", "PASS", "FAIL"], // regression
    ["fail-fail", "FAIL", "FAIL"],
    ["fail-pass", "FAIL", "PASS"],
    ["pass-pass", "PASS", "PASS"],
    ["warning-fail", "WARNING", "FAIL"],
    ["not-executed-fail", "NOT EXECUTED", "FAIL"],
  ] as const) {
    result(prev, title, before, { pageId: px });
    result(latest, title, after, { pageId: px });
  }
  result(prev, "only-older", "PASS", { pageId: px });
  result(latest, "only-newer", "FAIL", { pageId: px });
  result(prev, "other-page", "PASS", { pageId: px });
  result(latest, "other-page", "FAIL", { pageId: py }); // different page: not the same case
  result(prev, "other-module", "PASS", { module: "forms" });
  result(latest, "other-module", "FAIL", { module: "links" }); // different module: not the same case
  result(prev, "no-page", "PASS");
  result(latest, "no-page", "FAIL"); // no page on either side: the same case (regression)
  result(prev, "duplicate", "PASS");
  result(prev, "duplicate", "PASS");
  result(latest, "duplicate", "FAIL"); // two matching passes in the older run: reported once

  // More than two completed runs: ranked by COALESCE(completed_at, created_at), newest first.
  const many = await project("user-alice", "many");
  const m1 = run(many, "many-1", { completedAt: T(1), createdAt: T(1) });
  const m2 = run(many, "many-2", { completedAt: T(2), createdAt: T(2) });
  const m3 = run(many, "many-3", { completedAt: null, createdAt: T(4) }); // no completion time: falls back to created_at (newest)
  const m4 = run(many, "many-4", { completedAt: T(3), createdAt: T(3) }); // second newest
  run(many, "many-running", { status: "RUNNING", completedAt: null, createdAt: T(9) });
  result(m4, "compared", "PASS");
  result(m3, "compared", "FAIL"); // regression between many-4 and many-3
  result(m2, "older-pass", "PASS");
  result(m3, "older-pass", "FAIL"); // many-2 is not one of the two compared runs
  result(m1, "oldest-pass", "PASS");
  result(m2, "oldest-pass", "FAIL"); // many-1 → many-2 is not the latest pair

  // Ties on the completion time are broken by insertion order (rowid), newest first. The ids sort the other way, so
  // an id tie-break would choose different runs.
  const tie = await project("user-alice", "tie");
  const t1 = run(tie, "tie-1", { id: `${tie}-run-c`, completedAt: T(5) });
  const t2 = run(tie, "tie-2", { id: `${tie}-run-b`, completedAt: T(5) });
  const t3 = run(tie, "tie-3", { id: `${tie}-run-a`, completedAt: T(5) });
  result(t2, "tie-pair", "PASS");
  result(t3, "tie-pair", "FAIL"); // regression between tie-2 and tie-3
  result(t1, "tie-first", "PASS");
  result(t3, "tie-first", "FAIL"); // tie-1 is not compared
  result(t1, "tie-by-id", "PASS");
  result(t2, "tie-by-id", "FAIL"); // would be the regression if ties were broken by id

  const bob = await project("user-bob", "bob");
  const b1 = run(bob, "bob-prev", { completedAt: T(1) });
  const b2 = run(bob, "bob-latest", { completedAt: T(2) });
  result(b1, "bob-case", "PASS");
  result(b2, "bob-case", "FAIL");

  const legacy = await project(null, "legacy");
  const l1 = run(legacy, "legacy-prev", { completedAt: T(1) });
  const l2 = run(legacy, "legacy-latest", { completedAt: T(2) });
  result(l1, "legacy-case", "PASS");
  result(l2, "legacy-case", "FAIL");
}

/** A regression row as [project, latest-run case, previous run, latest run], using test labels. */
const label = (r: RegressionRecord) => {
  expect(r.projectName).toBe(labels.get(r.projectId));
  expect(labels.get(r.testCaseId)).toBe(`${labels.get(r.latestRunId)}:${r.testCaseTitle}`);
  return [labels.get(r.projectId), labels.get(r.testCaseId), labels.get(r.previousRunId), labels.get(r.latestRunId)].join(" | ");
};
const sorted = (rows: RegressionRecord[]) => rows.map(label).sort();

const ALICE = [
  "many | many-3:compared | many-4 | many-3",
  "tie | tie-3:tie-pair | tie-2 | tie-3",
  "two | two-latest:duplicate | two-prev | two-latest",
  "two | two-latest:no-page | two-prev | two-latest",
  "two | two-latest:pass-fail | two-prev | two-latest",
];
const BOB = ["bob | bob-latest:bob-case | bob-prev | bob-latest"];
const LEGACY = ["legacy | legacy-latest:legacy-case | legacy-prev | legacy-latest"];
const ALL = [...ALICE, ...BOB, ...LEGACY].sort();

/**
 * Records the SQL text and bound arguments of the regressions query, at the better-sqlite3 level. Every statement
 * (direct or through the SQL executor) is created by `prepare`, so this works for either implementation. Install it
 * before the first call: the SQL executor caches prepared statements.
 */
function captureBindings() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = base.sqlite.prepare.bind(base.sqlite);
  vi.spyOn(base.sqlite, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (!sql.includes("WITH ranked AS")) return stmt;
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
const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

beforeEach(() => {
  labels.clear();
  cases = 0;
  base = createTestDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await base.close();
});

describe("dashboard regressions", () => {
  it("returns an empty list for an empty database, with and without an owner", async () => {
    expect(await base.dashboard.getRegressions()).toEqual([]);
    expect(await base.dashboard.getRegressions(20, "user-alice")).toEqual([]);
    expect(await new OwnerScopedDatabaseProvider(base, "user-alice").dashboard.getRegressions()).toEqual([]);
  });

  it("finds no regressions for projects with fewer than two completed runs", async () => {
    await seed();
    const projects = new Set((await base.dashboard.getRegressions(500)).map((r) => labels.get(r.projectId)));
    expect(projects.has("zero")).toBe(false);
    expect(projects.has("one")).toBe(false);
  });

  it("compares exactly two completed runs: only cases that passed before and fail now, matched by module, title and page", async () => {
    await seed();
    const rows = sorted(await base.dashboard.getRegressions(500)).filter((r) => r.startsWith("two |"));
    // Not reported: fail→fail, fail→pass, pass→pass, warning→fail, not executed→fail, a case only in the older run,
    // a case only in the newer run, and cases whose page or module differs. A case with two matching passes appears once.
    expect(rows).toEqual(["two | two-latest:duplicate | two-prev | two-latest", "two | two-latest:no-page | two-prev | two-latest", "two | two-latest:pass-fail | two-prev | two-latest"]);
  });

  it("with more than two completed runs, compares the two newest by completion time (creation time when missing)", async () => {
    await seed();
    const rows = sorted(await base.dashboard.getRegressions(500)).filter((r) => r.startsWith("many |"));
    expect(rows).toEqual(["many | many-3:compared | many-4 | many-3"]);
  });

  it("breaks ties on the completion time by insertion order, deterministically", async () => {
    await seed();
    for (let i = 0; i < 3; i++) {
      const rows = sorted(await base.dashboard.getRegressions(500)).filter((r) => r.startsWith("tie |"));
      expect(rows).toEqual(["tie | tie-3:tie-pair | tie-2 | tie-3"]);
    }
  });

  it("includes every project, including unowned legacy data, when no owner filter is applied", async () => {
    await seed();
    expect(sorted(await base.dashboard.getRegressions(500))).toEqual(ALL);
  });

  it("restricts regressions to the owner's projects, with no cross-owner leakage", async () => {
    await seed();
    expect(sorted(await base.dashboard.getRegressions(500, "user-alice"))).toEqual(ALICE);
    expect(sorted(await base.dashboard.getRegressions(500, "user-bob"))).toEqual(BOB);
    expect(sorted(await new OwnerScopedDatabaseProvider(base, "user-alice").dashboard.getRegressions(500))).toEqual(ALICE);
    expect(sorted(await new OwnerScopedDatabaseProvider(base, "user-bob").dashboard.getRegressions(500))).toEqual(BOB);
    expect(await base.dashboard.getRegressions(500, "user-nobody")).toEqual([]);
    expect(await base.dashboard.getRegressions(500, "")).toEqual([]); // an empty owner matches nothing
  });

  it("applies the limit exactly as before", async () => {
    await seed();
    expect(await base.dashboard.getRegressions()).toHaveLength(ALL.length); // default 20
    expect(await base.dashboard.getRegressions(0)).toHaveLength(ALL.length); // invalid limits fall back to 100
    expect(await base.dashboard.getRegressions(Number.NaN)).toHaveLength(ALL.length);
    for (const limit of [1, 2, 2.7, 5]) {
      const rows = sorted(await base.dashboard.getRegressions(limit));
      expect(rows, String(limit)).toHaveLength(Math.floor(limit));
      for (const r of rows) expect(ALL).toContain(r);
    }
    expect(sorted(await base.dashboard.getRegressions(1, "user-bob"))).toEqual(BOB);
  });

  it("binds the owner id once before the limit when filtering, and only the limit otherwise", async () => {
    await seed();
    const calls = captureBindings();
    await base.dashboard.getRegressions(7, "user-alice");
    await base.dashboard.getRegressions();
    await base.dashboard.getRegressions(0, "");
    expect(calls).toHaveLength(3);
    const [scoped, unscoped, empty] = calls;
    expect(scoped.args).toEqual(["user-alice", 7]);
    expect(placeholders(scoped.sql)).toBe(2);
    expect(unscoped.args).toEqual([20]);
    expect(placeholders(unscoped.sql)).toBe(1);
    expect(empty.args).toEqual(["", 100]);
  });

  it("produces the recorded behaviour snapshot", async () => {
    const calls = captureBindings();
    const out: Record<string, unknown> = { emptyAll: await base.dashboard.getRegressions(), emptyAlice: await base.dashboard.getRegressions(20, "user-alice") };
    await seed();
    // Returned order is kept here (no sorting): same SQL on the same engine must return the same order.
    const raw = async (limit?: number, owner?: string) => (await base.dashboard.getRegressions(limit, owner)).map(label);
    out.all = await raw();
    out.all500 = await raw(500);
    out.alice = await raw(500, "user-alice");
    out.bob = await raw(500, "user-bob");
    out.nobody = await raw(500, "user-nobody");
    out.emptyOwner = await raw(500, "");
    out.limit2 = await raw(2);
    out.limit0 = await raw(0);
    out.scopedAlice = (await new OwnerScopedDatabaseProvider(base, "user-alice").dashboard.getRegressions()).map(label);
    out.bindings = calls.map((c) => ({ placeholders: placeholders(c.sql), args: c.args.map((a) => (typeof a === "string" ? a : `${typeof a}:${a}`)) }));
    out.sql = [...new Set(calls.map((c) => c.sql.replace(/\s+/g, " ").trim()))];
    if (process.env.QA_REGRESSIONS_BEHAVIOUR_OUT) fs.writeFileSync(process.env.QA_REGRESSIONS_BEHAVIOUR_OUT, JSON.stringify(out, null, 2));
    expect([...(out.alice as string[])].sort()).toEqual(ALICE);
  });
});
