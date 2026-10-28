import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import { createTestDb, projectInput } from "./helpers";

/**
 * Dashboard result trend (`getResultTrend`, in-memory SQLite only). Pins daily grouping, the time window,
 * status filtering, ordering, owner filtering and edge cases so the method can move onto the SQL executor
 * unchanged. Results are seeded directly into the in-memory test database.
 *
 * Set QA_TREND_BEHAVIOUR_OUT to a file path to also write the observations as JSON (used to compare the
 * implementation before and after a refactor).
 */

const NOW = "2026-03-10T12:00:00.000Z";

let base: LocalDatabaseProvider;
let alice: OwnerScopedDatabaseProvider;
let bob: OwnerScopedDatabaseProvider;
let aliceRun: string;
let bobRun: string;

async function seedRun(owner: string, name: string) {
  const project = await base.projects.create(projectInput({ name, websiteUrl: `https://${name}.test/` }), owner);
  const runId = randomUUID();
  base.sqlite.prepare("INSERT INTO test_runs (id, project_id, status) VALUES (?, ?, 'COMPLETED')").run(runId, project.id);
  return runId;
}

function result(runId: string, status: string, executedAt: string | null) {
  const projectId = (base.sqlite.prepare("SELECT project_id FROM test_runs WHERE id = ?").get(runId) as { project_id: string }).project_id;
  const caseId = randomUUID();
  base.sqlite.prepare("INSERT INTO test_cases (id, project_id, test_run_id, module, title) VALUES (?, ?, ?, 'links', 'case')").run(caseId, projectId, runId);
  base.sqlite.prepare("INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), runId, caseId, status, executedAt);
}

/** A typical spread: several results on the same day, several days, outside the window, excluded statuses. */
function seedSpread() {
  result(aliceRun, "PASS", "2026-03-10T08:00:00.000Z");
  result(aliceRun, "PASS", "2026-03-10T09:30:00.000Z");
  result(aliceRun, "FAIL", "2026-03-10T23:59:59.999Z");
  result(aliceRun, "WARNING", "2026-03-08T01:00:00.000Z");
  result(aliceRun, "PASS", "2026-03-08T02:00:00.000Z");
  result(aliceRun, "NOT EXECUTED", null); // never counted
  result(aliceRun, "NOT APPLICABLE", "2026-03-09T10:00:00.000Z"); // not one of PASS/FAIL/WARNING
  result(aliceRun, "FAIL", "2026-03-02T12:00:00.000Z"); // exactly 8 days before NOW
  result(aliceRun, "FAIL", "2026-01-01T00:00:00.000Z"); // far outside
  result(bobRun, "FAIL", "2026-03-09T12:00:00.000Z");
  result(bobRun, "WARNING", "2026-03-10T06:00:00.000Z");
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  base = createTestDb();
  aliceRun = await seedRun("user-alice", "alice");
  bobRun = await seedRun("user-bob", "bob");
  alice = new OwnerScopedDatabaseProvider(base, "user-alice");
  bob = new OwnerScopedDatabaseProvider(base, "user-bob");
});
afterEach(async () => {
  vi.useRealTimers();
  await base.close();
});

describe("dashboard result trend", () => {
  it("returns an empty list when there are no counted results", async () => {
    expect(await base.dashboard.getResultTrend(30)).toEqual([]);
    result(aliceRun, "NOT EXECUTED", null);
    result(aliceRun, "NOT APPLICABLE", NOW);
    expect(await base.dashboard.getResultTrend(30)).toEqual([]);
    expect(await alice.dashboard.getResultTrend(30)).toEqual([]);
  });

  it("groups by UTC day in ascending order, counting each status per day", async () => {
    seedSpread();
    expect(await base.dashboard.getResultTrend(7)).toEqual([
      { day: "2026-03-08", passed: 1, failed: 0, warnings: 1 },
      { day: "2026-03-09", passed: 0, failed: 1, warnings: 0 },
      { day: "2026-03-10", passed: 2, failed: 1, warnings: 1 },
    ]);
  });

  it("uses a window of `days` days back from now, inclusive of the boundary", async () => {
    seedSpread();
    const days = async (n: number) => (await base.dashboard.getResultTrend(n)).map((d) => d.day);
    expect(await days(1)).toEqual(["2026-03-09", "2026-03-10"]); // since 2026-03-09T12:00Z
    expect(await days(8)).toEqual(["2026-03-02", "2026-03-08", "2026-03-09", "2026-03-10"]); // boundary row included
    expect(await days(365)).toEqual(["2026-01-01", "2026-03-02", "2026-03-08", "2026-03-09", "2026-03-10"]);
    // Existing edge cases: a window below one day is treated as one day; fractional days are honoured.
    expect(await days(0)).toEqual(await days(1));
    expect(await days(-5)).toEqual(await days(1));
    expect(await days(0.25)).toEqual(await days(1));
    expect(await days(7.5)).toEqual(["2026-03-08", "2026-03-09", "2026-03-10"]);
  });

  it("throws the same error for a non-numeric window", async () => {
    await expect(base.dashboard.getResultTrend(Number.NaN)).rejects.toThrow(RangeError);
  });

  it("filters by owner, directly and through the scoped provider", async () => {
    seedSpread();
    expect(await base.dashboard.getResultTrend(7, "user-bob")).toEqual([
      { day: "2026-03-09", passed: 0, failed: 1, warnings: 0 },
      { day: "2026-03-10", passed: 0, failed: 0, warnings: 1 },
    ]);
    expect(await bob.dashboard.getResultTrend(7)).toEqual(await base.dashboard.getResultTrend(7, "user-bob"));
    expect(await alice.dashboard.getResultTrend(7)).toEqual([
      { day: "2026-03-08", passed: 1, failed: 0, warnings: 1 },
      { day: "2026-03-10", passed: 2, failed: 1, warnings: 0 },
    ]);
    expect(await base.dashboard.getResultTrend(7, "user-nobody")).toEqual([]);
    expect(await base.dashboard.getResultTrend(7, "")).toEqual([]); // an empty owner matches nothing
  });

  it("returns numbers, not strings", async () => {
    seedSpread();
    for (const point of await base.dashboard.getResultTrend(7)) {
      for (const key of ["passed", "failed", "warnings"] as const) expect(typeof point[key]).toBe("number");
      expect(typeof point.day).toBe("string");
    }
  });

  it("produces the recorded behaviour snapshot", async () => {
    const out: Record<string, unknown> = { empty: await base.dashboard.getResultTrend(30) };
    seedSpread();
    for (const n of [0, 1, 7, 7.5, 8, 30, 365]) out[`all_${n}`] = await base.dashboard.getResultTrend(n);
    out.bob = await base.dashboard.getResultTrend(30, "user-bob");
    out.alice = await base.dashboard.getResultTrend(30, "user-alice");
    out.emptyOwner = await base.dashboard.getResultTrend(30, "");
    out.scopedBob = await bob.dashboard.getResultTrend(30);
    out.nan = await base.dashboard.getResultTrend(Number.NaN).then(
      () => "resolved",
      (e: Error) => `${e.name}: ${e.message}`,
    );
    if (process.env.QA_TREND_BEHAVIOUR_OUT) fs.writeFileSync(process.env.QA_TREND_BEHAVIOUR_OUT, JSON.stringify(out, null, 2));
    expect(out.scopedBob).toEqual(out.bob);
  });
});
