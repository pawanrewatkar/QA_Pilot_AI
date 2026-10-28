import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import type { TestRunStatus } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Run history: `comparableRuns` (in-memory SQLite only). Pins which runs are offered for comparison (other finished
 * runs of the same project, older or newer), their order and mapping, the 100-run cap, the bound values and the owner
 * check, so the method can move onto the SQL executor unchanged. Rows are seeded directly, with fixed ids.
 *
 * Ties: the query orders by `created_at DESC` with no tie-break, so the order of runs sharing a timestamp is not
 * defined. Tests only assert which runs are returned in that case, never their order.
 *
 * Set QA_COMPARABLE_BEHAVIOUR_OUT to a file path to also write the observations as JSON (used to compare the
 * implementation before and after a refactor).
 */

const T = (n: number) => `2026-03-01T10:00:${String(n).padStart(2, "0")}.000Z`;
const day = (n: number) => `2026-04-${String(n).padStart(2, "0")}T00:00:00.000Z`;

let base: LocalDatabaseProvider;

const exec = (sql: string, ...args: unknown[]) => base.sqlite.prepare(sql).run(...args);

async function project(owner: string, slug: string) {
  const id = `project-${slug}`;
  // Renamed before anything references it.
  exec("UPDATE projects SET id = ? WHERE id = ?", id, (await base.projects.create(projectInput({ name: slug, websiteUrl: `https://${slug}.test/` }), owner)).id);
  return id;
}
function run(projectId: string, id: string, status: TestRunStatus, createdAt: string, name: string | null = id.toUpperCase()) {
  exec("INSERT INTO test_runs (id, project_id, status, name, created_at) VALUES (?, ?, ?, ?, ?)", id, projectId, status, name, createdAt);
}

/** Alice's project has runs in every status (r6 is the run being compared); Bob's project has one finished run. */
async function seed() {
  const alpha = await project("user-alice", "alpha");
  const gamma = await project("user-bob", "gamma");
  run(alpha, "r1", "COMPLETED", T(1));
  run(alpha, "r2", "FAILED", T(2), null);
  run(alpha, "r3", "CANCELLED", T(3));
  run(alpha, "r4", "RUNNING", T(4));
  run(alpha, "r5", "PENDING", T(5));
  run(alpha, "r6", "COMPLETED", T(6));
  run(alpha, "r7", "COMPLETED", T(7)); // newer than r6: still offered
  run(gamma, "g1", "COMPLETED", T(8));
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

/** Records the SQL text and bound arguments of both lookups at the better-sqlite3 level (old and new code). */
function captureBindings() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = base.sqlite.prepare.bind(base.sqlite);
  const watched = (sql: string) => sql === "SELECT project_id FROM test_runs WHERE id = ?" || sql.startsWith("SELECT id, name, status, created_at FROM test_runs WHERE project_id = ? AND id != ?");
  vi.spyOn(base.sqlite, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (!watched(sql)) return stmt;
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "get" || key === "all") return (...args: unknown[]) => (calls.push({ sql, args }), (target[key] as (...a: unknown[]) => unknown)(...args));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof base.sqlite.prepare);
  return calls;
}

beforeEach(() => {
  base = createTestDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await base.close();
});

describe("run history: comparableRuns", () => {
  it("returns an empty list for a missing run", async () => {
    expect(await base.history.comparableRuns("no-such-run")).toEqual([]);
    expect(await base.history.comparableRuns("")).toEqual([]);
  });

  it("returns an empty list when the project has no other finished run", async () => {
    await seed();
    expect(await base.history.comparableRuns("g1")).toEqual([]);
  });

  it("offers the other finished runs of the same project, newest first, mapped", async () => {
    await seed();
    expect(await base.history.comparableRuns("r6")).toEqual([
      { id: "r7", name: "R7", status: "COMPLETED", createdAt: T(7) },
      { id: "r3", name: "R3", status: "CANCELLED", createdAt: T(3) },
      { id: "r2", name: null, status: "FAILED", createdAt: T(2) },
      { id: "r1", name: "R1", status: "COMPLETED", createdAt: T(1) },
    ]);
  });

  it("works for a run that has not finished, and never offers unfinished runs or the run itself", async () => {
    await seed();
    expect(ids(await base.history.comparableRuns("r4"))).toEqual(["r7", "r6", "r3", "r2", "r1"]);
    expect(ids(await base.history.comparableRuns("r5"))).toEqual(["r7", "r6", "r3", "r2", "r1"]);
    expect(ids(await base.history.comparableRuns("r1"))).toEqual(["r7", "r6", "r3", "r2"]);
  });

  it("caps the list at the 100 newest runs", async () => {
    const alpha = await project("user-alice", "alpha");
    run(alpha, "current", "COMPLETED", day(28));
    for (let i = 0; i < 105; i++) run(alpha, `old-${String(i).padStart(3, "0")}`, "COMPLETED", new Date(Date.parse(day(1)) + i * 60_000).toISOString());
    const rows = await base.history.comparableRuns("current");
    expect(rows).toHaveLength(100);
    expect(rows[0].id).toBe("old-104");
    expect(rows[99].id).toBe("old-005");
  });

  it("returns every run tied on the timestamp, without relying on their order", async () => {
    const alpha = await project("user-alice", "alpha");
    run(alpha, "current", "COMPLETED", T(9));
    run(alpha, "tie-a", "COMPLETED", T(5));
    run(alpha, "tie-b", "FAILED", T(5));
    run(alpha, "older", "COMPLETED", T(1));
    const rows = ids(await base.history.comparableRuns("current"));
    expect(rows.slice(0, 2).sort()).toEqual(["tie-a", "tie-b"]); // either order is valid
    expect(rows[2]).toBe("older");
  });

  it("binds the run id, then the project id and run id", async () => {
    await seed();
    const calls = captureBindings();
    await base.history.comparableRuns("r6");
    await base.history.comparableRuns("missing");
    expect(calls.map((c) => c.args)).toEqual([["r6"], ["project-alpha", "r6"], ["missing"]]);
  });

  it("checks run ownership in the scoped provider before looking anything up", async () => {
    await seed();
    const lookup = vi.spyOn(base.history, "comparableRuns");
    const alice = new OwnerScopedDatabaseProvider(base, "user-alice");
    const bob = new OwnerScopedDatabaseProvider(base, "user-bob");
    expect(await bob.history.comparableRuns("r6")).toEqual([]); // another owner's run
    expect(await alice.history.comparableRuns("g1")).toEqual([]);
    expect(await alice.history.comparableRuns("missing")).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
    expect(ids(await alice.history.comparableRuns("r6"))).toEqual(["r7", "r3", "r2", "r1"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("produces the recorded behaviour snapshot", async () => {
    const calls = captureBindings();
    const out: Record<string, unknown> = { missing: await base.history.comparableRuns("missing") };
    await seed();
    for (const id of ["r1", "r4", "r6", "g1"]) out[id] = await base.history.comparableRuns(id);
    out.scopedAlice = await new OwnerScopedDatabaseProvider(base, "user-alice").history.comparableRuns("r6");
    out.scopedBob = await new OwnerScopedDatabaseProvider(base, "user-bob").history.comparableRuns("r6");
    out.bindings = calls.map((c) => c.args);
    out.sql = [...new Set(calls.map((c) => c.sql))];
    if (process.env.QA_COMPARABLE_BEHAVIOUR_OUT) fs.writeFileSync(process.env.QA_COMPARABLE_BEHAVIOUR_OUT, JSON.stringify(out, null, 2));
    expect(ids(out.r6 as { id: string }[])).toEqual(["r7", "r3", "r2", "r1"]);
  });
});
