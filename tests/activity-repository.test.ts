import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider, ResourceNotFoundError } from "@/lib/database/owner-scoped-provider";
import type { NewActivity } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Activity log repository behaviour (in-memory SQLite only). Pins owner resolution on insert, filtering by
 * project and owner (the shared projectScope helper), ordering with insertion-order tie-breaks, limits, nulls,
 * errors and ownership so the repository can move onto the SQL executor unchanged.
 *
 * Set QA_ACTIVITY_BEHAVIOUR_OUT to a file path to also write the normalized observations as JSON (used to
 * compare the implementation before and after a refactor).
 */

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-03-02T10:00:00.000Z";

let base: LocalDatabaseProvider;
let alice: OwnerScopedDatabaseProvider;
let bob: OwnerScopedDatabaseProvider;
let aliceProject: string;
let bobProject: string;

const entry = (projectId: string | null, summary: string, over: Partial<NewActivity> = {}): NewActivity => ({ projectId, entityType: "project", entityId: projectId, action: "updated", summary, ...over });

const at = <T>(time: string, fn: () => Promise<T>) => {
  vi.setSystemTime(new Date(time));
  return fn();
};

const ownerOf = (id: string) => (base.sqlite.prepare("SELECT owner_id FROM activity_log WHERE id = ?").get(id) as { owner_id: string | null }).owner_id;
const summaries = (rows: { summary: string }[]) => rows.map((r) => r.summary);

const errorOf = async (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: Error) => `${e.name}: ${e.message}`,
  );

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  base = createTestDb();
  aliceProject = (await base.projects.create(projectInput({ name: "Alice" }), "user-alice")).id;
  bobProject = (await base.projects.create(projectInput({ name: "Bob", websiteUrl: "https://bob.test/" }), "user-bob")).id;
  alice = new OwnerScopedDatabaseProvider(base, "user-alice");
  bob = new OwnerScopedDatabaseProvider(base, "user-bob");
  base.sqlite.exec("DELETE FROM activity_log"); // start every test from an empty log
});
afterEach(async () => {
  vi.useRealTimers();
  await base.close();
});

describe("activity repository", () => {
  it("returns empty results", async () => {
    expect(await base.activity.list()).toEqual([]);
    expect(await base.activity.list({ projectId: aliceProject })).toEqual([]);
    expect(await base.activity.list({ ownerId: "user-alice" })).toEqual([]);
    expect(await alice.activity.list()).toEqual([]);
  });

  it("records entries with the project name and resolves the owner", async () => {
    const a = await at(T1, () => base.activity.record(entry(aliceProject, "about alice")));
    expect(a).toEqual({ id: a.id, projectId: aliceProject, projectName: "Alice", entityType: "project", entityId: aliceProject, action: "updated", summary: "about alice", createdAt: T1 });
    expect(ownerOf(a.id)).toBe("user-alice"); // taken from the project
    const explicit = await base.activity.record(entry(aliceProject, "explicit owner", { ownerId: "user-bob" }));
    expect(ownerOf(explicit.id)).toBe("user-bob"); // an explicit owner wins
    const nullOwner = await base.activity.record(entry(aliceProject, "null owner", { ownerId: null }));
    expect(ownerOf(nullOwner.id)).toBe("user-alice"); // null falls back to the project
    const global = await base.activity.record(entry(null, "no project", { entityType: "settings", entityId: null }));
    expect(global).toMatchObject({ projectId: null, projectName: null, entityId: null });
    expect(ownerOf(global.id)).toBeNull();
  });

  it("orders newest first with insertion order breaking ties, and filters by project and owner", async () => {
    await at(T1, () => base.activity.record(entry(aliceProject, "a1")));
    await at(T2, () => base.activity.record(entry(aliceProject, "a2")));
    await at(T2, () => base.activity.record(entry(bobProject, "b1")));
    await at(T2, () => base.activity.record(entry(aliceProject, "a3")));
    await at(T1, () => base.activity.record(entry(null, "global")));
    expect(summaries(await base.activity.list())).toEqual(["a3", "b1", "a2", "global", "a1"]);
    expect(summaries(await base.activity.list({ projectId: aliceProject }))).toEqual(["a3", "a2", "a1"]);
    expect(summaries(await base.activity.list({ ownerId: "user-bob" }))).toEqual(["b1"]);
    expect(summaries(await base.activity.list({ projectId: aliceProject, ownerId: "user-alice" }))).toEqual(["a3", "a2", "a1"]);
    expect(await base.activity.list({ projectId: aliceProject, ownerId: "user-bob" })).toEqual([]);
    // Existing edge cases: an empty project id is ignored; an empty owner id matches nothing.
    expect(summaries(await base.activity.list({ projectId: "" }))).toHaveLength(5);
    expect(await base.activity.list({ ownerId: "" })).toEqual([]);
  });

  it("clamps the limit exactly as before", async () => {
    for (let i = 0; i < 501; i++) await base.activity.record(entry(aliceProject, `e${i}`));
    expect(await base.activity.list()).toHaveLength(100);
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(await base.activity.list({ limit }), String(limit)).toHaveLength(100);
    expect(await base.activity.list({ limit: 2.7 })).toHaveLength(2);
    expect(await base.activity.list({ limit: 10_000 })).toHaveLength(500);
    expect(await base.activity.list({ limit: 1, projectId: aliceProject })).toHaveLength(1);
  });

  it("keeps entries and their owner after the project is deleted", async () => {
    const a = await at(T1, () => base.activity.record(entry(aliceProject, "before delete")));
    expect(await base.projects.delete(aliceProject)).toBe(true);
    expect(await base.activity.list({ ownerId: "user-alice" })).toEqual([{ ...a, projectId: null, projectName: null }]);
    expect(await base.activity.list({ projectId: aliceProject })).toEqual([]);
  });

  it("rejects invalid entries with the same database errors and writes nothing", async () => {
    expect(await errorOf(base.activity.record(entry("no-such-project", "x")))).toBe("SqliteError: FOREIGN KEY constraint failed");
    expect(await errorOf(base.activity.record(entry(aliceProject, null as never)))).toBe("SqliteError: NOT NULL constraint failed: activity_log.summary");
    expect(await errorOf(base.activity.record(entry(aliceProject, "x", { action: undefined as never })))).toBe("SqliteError: NOT NULL constraint failed: activity_log.action");
    expect(await base.activity.list()).toEqual([]);
  });

  it("keeps the log isolated per owner through the scoped provider", async () => {
    await at(T1, () => alice.activity.record(entry(aliceProject, "alice work")));
    await at(T1, () => bob.activity.record(entry(bobProject, "bob work")));
    const aliceGlobal = await at(T2, () => alice.activity.record(entry(null, "alice global", { entityId: null })));
    expect(ownerOf(aliceGlobal.id)).toBe("user-alice"); // the scoped provider always sets the owner
    expect(summaries(await alice.activity.list())).toEqual(["alice global", "alice work"]);
    expect(summaries(await bob.activity.list())).toEqual(["bob work"]);
    expect(await bob.activity.list({ projectId: aliceProject })).toEqual([]);
    await expect(bob.activity.record(entry(aliceProject, "intruder"))).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(summaries(await base.activity.list())).not.toContain("intruder");
  });

  it("produces the recorded behaviour snapshot", async () => {
    const labels = new Map<string, string>();
    const label = (id: string) => labels.get(id) ?? (labels.set(id, `act${labels.size + 1}`), labels.get(id)!);
    const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === "id" && typeof x === "string" ? label(x) : x)));
    const out: Record<string, unknown> = {};
    out.empty = norm(await base.activity.list());
    out.recorded = norm([
      await at(T1, () => base.activity.record(entry(aliceProject, "a1"))),
      await at(T2, () => base.activity.record(entry(aliceProject, "a2", { ownerId: null }))),
      await at(T2, () => base.activity.record(entry(bobProject, "b1"))),
      await at(T2, () => base.activity.record(entry(null, "global", { entityType: "settings", entityId: null }))),
      await at(T1, () => base.activity.record(entry(aliceProject, "explicit", { ownerId: "user-bob" }))),
    ]);
    const lists = {
      all: norm(await base.activity.list()),
      byProject: norm(await base.activity.list({ projectId: aliceProject })),
      byOwner: norm(await base.activity.list({ ownerId: "user-bob" })),
      both: norm(await base.activity.list({ projectId: aliceProject, ownerId: "user-alice" })),
      emptyProject: norm(await base.activity.list({ projectId: "" })),
      emptyOwner: norm(await base.activity.list({ ownerId: "" })),
      limit2: norm(await base.activity.list({ limit: 2 })),
      limitFraction: norm(await base.activity.list({ limit: 1.9 })),
    };
    out.lists = lists;
    out.scoped = { alice: norm(await alice.activity.list()), bob: norm(await bob.activity.list()), bobIntoAlice: await errorOf(bob.activity.record(entry(aliceProject, "intruder"))) };
    out.errors = [await errorOf(base.activity.record(entry("no-such-project", "x"))), await errorOf(base.activity.record(entry(aliceProject, null as never)))];
    await base.projects.delete(bobProject);
    out.afterProjectDelete = norm(await base.activity.list({ ownerId: "user-bob" }));
    out.raw = base.sqlite.prepare("SELECT project_id, entity_type, entity_id, action, summary, created_at, owner_id FROM activity_log ORDER BY created_at, summary").all();
    if (process.env.QA_ACTIVITY_BEHAVIOUR_OUT) {
      // Project ids are random per run; replace them so two runs can be compared byte for byte.
      const text = JSON.stringify(out, null, 2).replaceAll(aliceProject, "<alice-project>").replaceAll(bobProject, "<bob-project>");
      fs.writeFileSync(process.env.QA_ACTIVITY_BEHAVIOUR_OUT, text);
    }
    expect(summaries(lists.all as { summary: string }[])).toEqual(["global", "b1", "a2", "explicit", "a1"]);
  });
});
