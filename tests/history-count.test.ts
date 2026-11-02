import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import type { HistoryQuery, TestRunStatus } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Run history: `countRuns` (in-memory SQLite only). Pins the count for every filter (project, owner, status, search
 * with LIKE escaping) and their combinations, the order of the bound values, ownership through the scoped provider,
 * and agreement with `listRuns` (same filters), so the method can move onto the SQL executor unchanged. Rows are
 * seeded directly, with fixed ids.
 *
 * Set QA_HISTORY_COUNT_BEHAVIOUR_OUT to a file path to also write the observations as JSON (used to compare the
 * implementation before and after a refactor).
 */

// Records the constructor arguments of every LocalHistoryRepository.
const { constructed } = vi.hoisted(() => ({ constructed: [] as unknown[][] }));
vi.mock("@/lib/database/local/history-repository", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/database/local/history-repository")>();
  class RecordingHistoryRepository extends mod.LocalHistoryRepository {
    constructor(...args: ConstructorParameters<typeof mod.LocalHistoryRepository>) {
      super(...args);
      constructed.push(args);
    }
  }
  return { ...mod, LocalHistoryRepository: RecordingHistoryRepository };
});

let base: LocalDatabaseProvider;

const exec = (sql: string, ...args: unknown[]) => base.sqlite.prepare(sql).run(...args);

async function project(owner: string | null, slug: string, name: string) {
  const id = `project-${slug}`;
  // Renamed before anything references it.
  exec("UPDATE projects SET id = ? WHERE id = ?", id, (await base.projects.create(projectInput({ name, websiteUrl: `https://${slug}.test/` }), owner ?? "temp")).id);
  if (owner === null) exec("UPDATE projects SET owner_id = NULL WHERE id = ?", id); // legacy row: visible to no owner
  return id;
}
function run(projectId: string, id: string, status: TestRunStatus, name: string | null) {
  exec("INSERT INTO test_runs (id, project_id, status, name) VALUES (?, ?, ?, ?)", id, projectId, status, name);
}

/** Alice: two projects, six runs; Bob: one project, two runs; plus one run of a legacy project without an owner. */
async function seed() {
  const alpha = await project("user-alice", "alpha", "Alpha Shop");
  const beta = await project("user-alice", "beta", "Beta_Blog");
  const gamma = await project("user-bob", "gamma", "Gamma");
  const legacy = await project(null, "legacy", "Legacy");
  run(alpha, "r1", "COMPLETED", "Release 1.0");
  run(alpha, "r2", "FAILED", "Nightly");
  run(alpha, "r3", "RUNNING", null);
  run(alpha, "r4", "COMPLETED", "50% rollout");
  run(beta, "r5", "COMPLETED", "Release 2.0");
  run(beta, "r6", "CANCELLED", "smoke_test");
  run(gamma, "r7", "COMPLETED", "Release 1.0");
  run(gamma, "r8", "PENDING", "Nightly");
  run(legacy, "r9", "COMPLETED", "Release old");
}

/** Every query exercised, with its expected count. */
const CASES: [string, HistoryQuery, number][] = [
  ["all", {}, 9],
  ["project", { projectId: "project-alpha" }, 4],
  ["unknown project", { projectId: "project-none" }, 0],
  ["empty project id (ignored)", { projectId: "" }, 9],
  ["status completed", { status: "COMPLETED" }, 5],
  ["status failed", { status: "FAILED" }, 1],
  ["status pending", { status: "PENDING" }, 1],
  ["owner alice", { ownerId: "user-alice" }, 6],
  ["owner bob", { ownerId: "user-bob" }, 2],
  ["unknown owner", { ownerId: "user-nobody" }, 0],
  ["empty owner (matches nothing)", { ownerId: "" }, 0],
  ["search run name", { search: "Release" }, 4],
  ["search is case-insensitive (ASCII)", { search: "release" }, 4],
  ["search is trimmed", { search: "  Release  " }, 4],
  ["blank search (ignored)", { search: "   " }, 9],
  ["search % is literal", { search: "%" }, 1],
  ["search _ is literal", { search: "_" }, 2], // smoke_test, and Beta_Blog's other run
  ["search backslash is literal", { search: "\\" }, 0],
  ["search website", { search: "alpha.test" }, 4],
  ["search project name", { search: "Gamma" }, 2],
  ["search no match", { search: "nothing-matches" }, 0],
  ["owner + status", { ownerId: "user-alice", status: "COMPLETED" }, 3],
  ["owner + search", { ownerId: "user-alice", search: "Release" }, 2],
  ["project + other owner", { projectId: "project-alpha", ownerId: "user-bob" }, 0],
  ["status + search", { status: "COMPLETED", search: "Release" }, 4],
  ["all filters", { projectId: "project-gamma", ownerId: "user-bob", status: "PENDING", search: "Nightly" }, 1],
  ["all filters, no match", { projectId: "project-gamma", ownerId: "user-bob", status: "COMPLETED", search: "Nightly" }, 0],
  ["limit and offset do not apply", { limit: 1, offset: 5 }, 9],
];

/** Records the SQL text and bound arguments of the count query at the better-sqlite3 level (old and new code). */
function captureBindings() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = base.sqlite.prepare.bind(base.sqlite);
  vi.spyOn(base.sqlite, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (!sql.startsWith("SELECT COUNT(*) AS c FROM test_runs r JOIN projects p")) return stmt;
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

beforeEach(() => {
  constructed.length = 0;
  base = createTestDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await base.close();
});

describe("run history: countRuns", () => {
  it("returns zero for an empty database, with and without filters", async () => {
    expect(await base.history.countRuns()).toBe(0);
    expect(await base.history.countRuns({ ownerId: "user-alice", status: "COMPLETED", search: "x" })).toBe(0);
    expect(await new OwnerScopedDatabaseProvider(base, "user-alice").history.countRuns()).toBe(0);
  });

  it("counts the runs matching each filter and combination", async () => {
    await seed();
    for (const [label, query, expected] of CASES) expect(await base.history.countRuns(query), label).toBe(expected);
  });

  it("agrees with listRuns for the same filters", async () => {
    await seed();
    for (const [label, query] of CASES) expect(await base.history.countRuns(query), label).toBe((await base.history.listRuns({ ...query, limit: 200, offset: 0 })).length);
  });

  it("binds project, owner, status, then the search pattern three times", async () => {
    await seed();
    const calls = captureBindings();
    await base.history.countRuns({ search: " 5%_\\ ", status: "COMPLETED", ownerId: "user-alice", projectId: "project-alpha" });
    await base.history.countRuns();
    await base.history.countRuns({ ownerId: "" });
    expect(calls.map((c) => c.args)).toEqual([["project-alpha", "user-alice", "COMPLETED", "%5\\%\\_\\\\%", "%5\\%\\_\\\\%", "%5\\%\\_\\\\%"], [], [""]]);
    expect(calls.map((c) => (c.sql.match(/\?/g) ?? []).length)).toEqual([6, 0, 1]);
  });

  it("returns a number", async () => {
    await seed();
    expect(typeof (await base.history.countRuns())).toBe("number");
  });

  it("keeps counts isolated per owner through the scoped provider", async () => {
    await seed();
    const alice = new OwnerScopedDatabaseProvider(base, "user-alice");
    const bob = new OwnerScopedDatabaseProvider(base, "user-bob");
    expect(await alice.history.countRuns()).toBe(6);
    expect(await bob.history.countRuns()).toBe(2);
    expect(await alice.history.countRuns({ projectId: "project-gamma" })).toBe(0); // another owner's project
    expect(await bob.history.countRuns({ search: "Alpha" })).toBe(0);
    // A caller-supplied owner id is replaced by the scoped owner.
    expect(await alice.history.countRuns({ ownerId: "user-bob" })).toBe(6);
    expect(await alice.history.countRuns({ status: "COMPLETED" })).toBe(3);
  });

  it("is constructed by the provider with its SQL executor only", () => {
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toEqual([base.sql]);
    expect(constructed[0][0]).toBe(base.sql);
  });

  it("produces the recorded behaviour snapshot", async () => {
    const calls = captureBindings();
    const out: Record<string, unknown> = { empty: await base.history.countRuns() };
    await seed();
    out.counts = Object.fromEntries(await Promise.all(CASES.map(async ([label, query]) => [label, await base.history.countRuns(query)] as const)));
    out.scoped = { alice: await new OwnerScopedDatabaseProvider(base, "user-alice").history.countRuns(), bob: await new OwnerScopedDatabaseProvider(base, "user-bob").history.countRuns() };
    out.bindings = calls.map((c) => c.args);
    out.sql = [...new Set(calls.map((c) => c.sql))];
    if (process.env.QA_HISTORY_COUNT_BEHAVIOUR_OUT) fs.writeFileSync(process.env.QA_HISTORY_COUNT_BEHAVIOUR_OUT, JSON.stringify(out, null, 2));
    expect(out.empty).toBe(0);
  });
});
