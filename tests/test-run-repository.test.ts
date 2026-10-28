import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import { createTestDb, projectInput } from "./helpers";

/**
 * Test runs repository: `list` and `getById` (in-memory SQLite only). Pins results, filtering by project and
 * owner, ordering with insertion-order tie-breaks, limits and ownership so these two methods can move onto the
 * SQL executor unchanged. Runs are created through the existing createAndEnqueue path.
 *
 * Set QA_RUNS_BEHAVIOUR_OUT to a file path to also write the normalized observations as JSON (used to compare
 * the implementation before and after a refactor).
 */

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-03-02T10:00:00.000Z";

let base: LocalDatabaseProvider;
let alice: OwnerScopedDatabaseProvider;
let bob: OwnerScopedDatabaseProvider;
let aliceProject: string;
let bobProject: string;
const pages = new Map<string, string>();
/** Test label of each created run (TestRun records carry no name). */
const runLabels = new Map<string, string>();

async function run(projectId: string, name: string, time: string) {
  vi.setSystemTime(new Date(time));
  const created = await base.testRuns.createAndEnqueue({
    projectId,
    configurationId: null,
    name,
    modules: ["links"],
    browsers: ["chromium"],
    viewports: ["desktop-1440x900"],
    pageIds: [pages.get(projectId)!],
    configurationName: null,
    options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 },
  });
  runLabels.set(created.id, name);
  return created;
}

const names = (runs: { id: string }[]) => runs.map((r) => runLabels.get(r.id));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  runLabels.clear();
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

describe("test runs repository: list and getById", () => {
  it("returns empty results and null for missing runs", async () => {
    expect(await base.testRuns.list()).toEqual([]);
    expect(await base.testRuns.list({ projectId: aliceProject })).toEqual([]);
    expect(await base.testRuns.list({ projectId: "no-such-project" })).toEqual([]);
    expect(await base.testRuns.list({ ownerId: "user-alice" })).toEqual([]);
    expect(await base.testRuns.getById("no-such-run")).toBeNull();
    expect(await base.testRuns.getById("")).toBeNull();
  });

  it("returns the same record from createAndEnqueue, getById and list", async () => {
    const r = await run(aliceProject, "first", T1);
    expect(r).toEqual({ id: r.id, projectId: aliceProject, projectName: "Alice", configurationId: null, status: "PENDING", startedAt: null, completedAt: null, errorMessage: null, createdAt: T1 });
    expect(await base.testRuns.getById(r.id)).toEqual(r);
    expect(await base.testRuns.list()).toEqual([r]);
  });

  it("orders newest first with insertion order breaking ties, and filters by project and owner", async () => {
    await run(aliceProject, "a1", T1);
    await run(aliceProject, "a2", T2);
    await run(bobProject, "b1", T2);
    await run(aliceProject, "a3", T2);
    expect(names(await base.testRuns.list())).toEqual(["a3", "b1", "a2", "a1"]);
    expect(names(await base.testRuns.list({ projectId: aliceProject }))).toEqual(["a3", "a2", "a1"]);
    expect(names(await base.testRuns.list({ ownerId: "user-bob" }))).toEqual(["b1"]);
    expect(names(await base.testRuns.list({ projectId: aliceProject, ownerId: "user-alice" }))).toEqual(["a3", "a2", "a1"]);
    expect(await base.testRuns.list({ projectId: aliceProject, ownerId: "user-bob" })).toEqual([]);
    // Existing edge cases: an empty project id is ignored; an empty owner id matches nothing.
    expect(await base.testRuns.list({ projectId: "" })).toHaveLength(4);
    expect(await base.testRuns.list({ ownerId: "" })).toEqual([]);
  });

  it("clamps the limit exactly as before", async () => {
    for (let i = 0; i < 101; i++) await run(aliceProject, `r${i}`, T1);
    expect(await base.testRuns.list()).toHaveLength(100);
    for (const limit of [0, -1, Number.NaN]) expect(await base.testRuns.list({ limit }), String(limit)).toHaveLength(100);
    expect(await base.testRuns.list({ limit: 2.7 })).toHaveLength(2);
    expect(await base.testRuns.list({ limit: 1, projectId: aliceProject })).toHaveLength(1);
  });

  it("reflects changes made through the other run methods, and removes runs with their project", async () => {
    const r = await run(aliceProject, "to cancel", T1);
    expect(await base.testRuns.requestCancel(r.id)).toBe(true);
    const after = await base.testRuns.getById(r.id);
    expect(after?.status).toBe("CANCELLED");
    expect((await base.testRuns.list())[0]).toEqual(after);
    expect(await base.projects.delete(aliceProject)).toBe(true);
    expect(await base.testRuns.getById(r.id)).toBeNull();
    expect(await base.testRuns.list({ projectId: aliceProject })).toEqual([]);
  });

  it("keeps runs isolated per owner through the scoped provider", async () => {
    const a = await run(aliceProject, "alice run", T1);
    const b = await run(bobProject, "bob run", T2);
    expect(await alice.testRuns.list()).toEqual([a]);
    expect(await bob.testRuns.list()).toEqual([b]);
    expect(await bob.testRuns.list({ projectId: aliceProject })).toEqual([]);
    expect(await alice.testRuns.getById(a.id)).toEqual(a);
    expect(await bob.testRuns.getById(a.id)).toBeNull();
  });

  it("produces the recorded behaviour snapshot", async () => {
    const labels = new Map<string, string>();
    const label = (id: string) => labels.get(id) ?? (labels.set(id, `run${labels.size + 1}`), labels.get(id)!);
    const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === "id" && typeof x === "string" ? label(x) : x)));
    const out: Record<string, unknown> = {};
    out.empty = { list: norm(await base.testRuns.list()), get: norm(await base.testRuns.getById("missing")) };
    const r1 = await run(aliceProject, "a1", T1);
    const r2 = await run(aliceProject, "a2", T2);
    await run(bobProject, "b1", T2);
    await run(aliceProject, "a3", T2);
    out.created = norm(r1);
    out.get = norm(await base.testRuns.getById(r2.id));
    out.lists = {
      all: norm(await base.testRuns.list()),
      byProject: norm(await base.testRuns.list({ projectId: aliceProject })),
      byOwner: norm(await base.testRuns.list({ ownerId: "user-bob" })),
      both: norm(await base.testRuns.list({ projectId: aliceProject, ownerId: "user-alice" })),
      emptyProject: norm(await base.testRuns.list({ projectId: "" })),
      emptyOwner: norm(await base.testRuns.list({ ownerId: "" })),
      limit2: norm(await base.testRuns.list({ limit: 2 })),
    };
    out.scoped = { alice: norm(await alice.testRuns.list()), bob: norm(await bob.testRuns.list()), bobGetsAlice: norm(await bob.testRuns.getById(r1.id)) };
    await base.testRuns.requestCancel(r1.id);
    out.afterCancel = norm(await base.testRuns.getById(r1.id));
    if (process.env.QA_RUNS_BEHAVIOUR_OUT) {
      // Ids are random per run; replace them so two runs can be compared byte for byte.
      let text = JSON.stringify(out, null, 2).replaceAll(aliceProject, "<alice-project>").replaceAll(bobProject, "<bob-project>");
      for (const [p, page] of pages) text = text.replaceAll(page, p === aliceProject ? "<alice-page>" : "<bob-page>");
      fs.writeFileSync(process.env.QA_RUNS_BEHAVIOUR_OUT, text);
    }
    // Labels follow first appearance: a1=run1, a2=run2, a3=run3, b1=run4.
    expect((out.lists as { all: { id: string }[] }).all.map((r) => r.id)).toEqual(["run3", "run4", "run2", "run1"]);
  });
});
