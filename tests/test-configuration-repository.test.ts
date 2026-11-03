import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPORT_SECTIONS } from "@/lib/constants/testing";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider, ResourceNotFoundError } from "@/lib/database/owner-scoped-provider";
import type { TestConfigurationInput } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Test configurations repository behaviour (in-memory SQLite only). Pins results, ordering, JSON round-trips,
 * update semantics, errors and ownership so the repository can move onto the SQL executor unchanged.
 *
 * Set QA_CONFIGS_BEHAVIOUR_OUT to a file path to also write the normalized observations as JSON (used to
 * compare the implementation before and after a refactor).
 */

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-03-02T10:00:00.000Z";
const T3 = "2026-03-03T10:00:00.000Z";

let base: LocalDatabaseProvider;
let alice: OwnerScopedDatabaseProvider;
let bob: OwnerScopedDatabaseProvider;
let aliceProject: string;
let bobProject: string;

const input = (projectId: string, name: string, over: Partial<TestConfigurationInput> = {}): TestConfigurationInput => ({
  projectId,
  name,
  scope: "MANUAL_URLS",
  selectedPageIds: [],
  manualUrls: [`https://example.test/${name}`],
  modules: ["links", "seo"],
  browsers: ["chromium"],
  viewports: ["desktop-1440x900"],
  reportFormats: ["EXCEL"],
  reportSections: DEFAULT_REPORT_SECTIONS,
  ...over,
});

const at = <T>(time: string, fn: () => Promise<T>) => {
  vi.setSystemTime(new Date(time));
  return fn();
};

const errorOf = async (p: Promise<unknown>) =>
  p.then(
    (v) => `resolved: ${JSON.stringify(v)}`,
    (e: Error) => `${e.name}: ${e.message}`,
  );

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  base = createTestDb();
  aliceProject = (await base.projects.create(projectInput({ name: "Alice" }), "user-alice")).id;
  bobProject = (await base.projects.create(projectInput({ name: "Bob", websiteUrl: "https://bob.test/" }), "user-bob")).id;
  alice = new OwnerScopedDatabaseProvider(base, "user-alice");
  bob = new OwnerScopedDatabaseProvider(base, "user-bob");
});
afterEach(async () => {
  vi.useRealTimers();
  await base.close();
});

describe("test configurations repository", () => {
  it("returns empty results and nulls for missing records", async () => {
    expect(await base.testConfigurations.listByProject(aliceProject)).toEqual([]);
    expect(await base.testConfigurations.listByProject("no-such-project")).toEqual([]);
    expect(await base.testConfigurations.getById("no-such-config")).toBeNull();
    expect(await base.testConfigurations.getById("")).toBeNull();
    expect(await base.testConfigurations.delete("no-such-config")).toBe(false);
    expect(await base.testConfigurations.update("no-such-config", input(aliceProject, "x"))).toBeNull();
    expect(await base.testConfigurations.listByProject(aliceProject)).toEqual([]); // update never inserts
  });

  it("creates and reads configurations with every JSON field round-tripped", async () => {
    const sections = { ...DEFAULT_REPORT_SECTIONS, executiveSummary: false };
    const c = await at(T1, () =>
      base.testConfigurations.create(
        input(aliceProject, "Full ✓", { scope: "SELECTED_PAGES", selectedPageIds: ["p1", "p2"], manualUrls: [], browsers: ["chromium", "firefox"], viewports: ["desktop-1440x900", "mobile-390x844"], reportFormats: ["PDF", "EXCEL"], reportSections: sections }),
      ),
    );
    expect(c).toEqual({
      id: c.id,
      projectId: aliceProject,
      name: "Full ✓",
      scope: "SELECTED_PAGES",
      selectedPageIds: ["p1", "p2"],
      manualUrls: [],
      modules: ["links", "seo"],
      browsers: ["chromium", "firefox"],
      viewports: ["desktop-1440x900", "mobile-390x844"],
      reportFormats: ["PDF", "EXCEL"],
      reportSections: sections,
      createdAt: T1,
      updatedAt: T1,
    });
    expect(await base.testConfigurations.getById(c.id)).toEqual(c);
  });

  it("orders by last update, newest insert first on ties, and updates in place", async () => {
    const c1 = await at(T1, () => base.testConfigurations.create(input(aliceProject, "one")));
    const c2 = await at(T2, () => base.testConfigurations.create(input(aliceProject, "two")));
    const c3 = await at(T2, () => base.testConfigurations.create(input(aliceProject, "three")));
    await at(T1, () => base.testConfigurations.create(input(bobProject, "bob")));
    const names = async () => (await base.testConfigurations.listByProject(aliceProject)).map((c) => c.name);
    expect(await names()).toEqual(["three", "two", "one"]);

    const updated = await at(T3, () => base.testConfigurations.update(c1.id, input(aliceProject, "one v2", { scope: "ENTIRE_WEBSITE", manualUrls: [], modules: ["accessibility"] })));
    expect(updated).toEqual({ ...c1, name: "one v2", scope: "ENTIRE_WEBSITE", manualUrls: [], modules: ["accessibility"], updatedAt: T3 });
    expect(updated?.createdAt).toBe(T1);
    expect(await names()).toEqual(["one v2", "three", "two"]);
    expect(c2.id).not.toBe(c3.id);
  });

  it("never moves a configuration to another project on update", async () => {
    const c = await at(T1, () => base.testConfigurations.create(input(aliceProject, "mine")));
    expect(await at(T2, () => base.testConfigurations.update(c.id, input(bobProject, "moved")))).toBeNull();
    expect(await base.testConfigurations.getById(c.id)).toEqual(c);
    expect(await base.testConfigurations.listByProject(bobProject)).toEqual([]);
  });

  it("rejects invalid rows with the same database errors and writes nothing", async () => {
    const c = await at(T1, () => base.testConfigurations.create(input(aliceProject, "ok")));
    expect(await errorOf(base.testConfigurations.create(input("no-such-project", "x")))).toBe("SqliteError: FOREIGN KEY constraint failed");
    expect(await errorOf(base.testConfigurations.create(input(aliceProject, "x", { scope: "EVERYTHING" as never })))).toMatch(/^SqliteError: CHECK constraint failed/);
    expect(await errorOf(base.testConfigurations.update(c.id, input(aliceProject, "x", { scope: "EVERYTHING" as never })))).toMatch(/^SqliteError: CHECK constraint failed/);
    expect(await errorOf(base.testConfigurations.create(input(aliceProject, null as never)))).toMatch(/^SqliteError: NOT NULL constraint failed: test_configurations.name/);
    expect(await base.testConfigurations.listByProject(aliceProject)).toEqual([c]);
  });

  it("detaches runs when a configuration is deleted, and deletes configurations with their project", async () => {
    const c = await at(T1, () => base.testConfigurations.create(input(aliceProject, "used")));
    const { page } = await base.pages.addManual(aliceProject, "https://example.test/", "https://example.test/");
    const run = await base.testRuns.createAndEnqueue({ projectId: aliceProject, configurationId: c.id, name: "run", modules: ["links"], browsers: ["chromium"], viewports: ["desktop-1440x900"], pageIds: [page.id], configurationName: c.name, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 } });
    expect(await base.testConfigurations.delete(c.id)).toBe(true);
    expect(await base.testConfigurations.delete(c.id)).toBe(false);
    expect((await base.testRuns.getById(run.id))?.configurationId).toBeNull();
    await at(T2, () => base.testConfigurations.create(input(aliceProject, "other")));
    expect(await base.projects.delete(aliceProject)).toBe(true);
    expect(await base.testConfigurations.listByProject(aliceProject)).toEqual([]);
  });

  it("keeps configurations isolated per owner through the scoped provider", async () => {
    const a = await at(T1, () => base.testConfigurations.create(input(aliceProject, "alice")));
    expect(await alice.testConfigurations.getById(a.id)).toEqual(a);
    expect(await alice.testConfigurations.listByProject(aliceProject)).toEqual([a]);
    expect(await bob.testConfigurations.getById(a.id)).toBeNull();
    expect(await bob.testConfigurations.listByProject(aliceProject)).toEqual([]);
    expect(await bob.testConfigurations.update(a.id, input(aliceProject, "hijack"))).toBeNull();
    expect(await bob.testConfigurations.update(a.id, input(bobProject, "hijack"))).toBeNull();
    expect(await bob.testConfigurations.delete(a.id)).toBe(false);
    await expect(bob.testConfigurations.create(input(aliceProject, "intruder"))).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await base.testConfigurations.listByProject(aliceProject)).toEqual([a]); // untouched by bob
    expect(await at(T2, () => alice.testConfigurations.update(a.id, input(aliceProject, "renamed")))).toMatchObject({ name: "renamed", updatedAt: T2 });
  });

  it("produces the recorded behaviour snapshot", async () => {
    const labels = new Map<string, string>();
    const label = (id: string) => labels.get(id) ?? (labels.set(id, `cfg${labels.size + 1}`), labels.get(id)!);
    const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === "id" && typeof x === "string" ? label(x) : x)));
    const out: Record<string, unknown> = {};
    out.empty = { list: norm(await base.testConfigurations.listByProject(aliceProject)), get: norm(await base.testConfigurations.getById("missing")), del: await base.testConfigurations.delete("missing"), upd: norm(await base.testConfigurations.update("missing", input(aliceProject, "x"))) };
    const c1 = await at(T1, () => base.testConfigurations.create(input(aliceProject, "one")));
    const c2 = await at(T2, () => base.testConfigurations.create(input(aliceProject, "two", { scope: "SELECTED_PAGES", selectedPageIds: ["p1"], manualUrls: [] })));
    const c3 = await at(T2, () => base.testConfigurations.create(input(aliceProject, "three", { scope: "ENTIRE_WEBSITE", manualUrls: [], reportFormats: [] })));
    out.created = norm([c1, c2, c3]);
    out.list = norm(await base.testConfigurations.listByProject(aliceProject));
    out.update = norm(await at(T3, () => base.testConfigurations.update(c2.id, input(aliceProject, "two v2", { modules: ["performance"] }))));
    out.crossProjectUpdate = norm(await base.testConfigurations.update(c1.id, input(bobProject, "moved")));
    out.listAfterUpdate = norm(await base.testConfigurations.listByProject(aliceProject));
    out.errors = [
      await errorOf(base.testConfigurations.create(input("no-such-project", "x"))),
      await errorOf(base.testConfigurations.create(input(aliceProject, "x", { scope: "EVERYTHING" as never }))),
      await errorOf(base.testConfigurations.update(c1.id, input(aliceProject, "x", { scope: "EVERYTHING" as never }))),
    ];
    out.scoped = {
      bobGet: norm(await bob.testConfigurations.getById(c1.id)),
      bobList: norm(await bob.testConfigurations.listByProject(aliceProject)),
      bobUpdate: norm(await bob.testConfigurations.update(c1.id, input(aliceProject, "hijack"))),
      bobDelete: await bob.testConfigurations.delete(c1.id),
      bobCreate: await errorOf(bob.testConfigurations.create(input(aliceProject, "intruder"))),
    };
    out.deletes = [await base.testConfigurations.delete(c3.id), await base.testConfigurations.delete(c3.id)];
    out.listAfterDelete = norm(await base.testConfigurations.listByProject(aliceProject));
    out.raw = base.sqlite
      .prepare("SELECT name, scope, selected_page_ids, manual_urls, modules, browsers, viewports, report_formats, report_sections, created_at, updated_at FROM test_configurations ORDER BY name")
      .all();
    if (process.env.QA_CONFIGS_BEHAVIOUR_OUT) {
      // Project ids are random per run; replace them so two runs can be compared byte for byte.
      const text = JSON.stringify(out, null, 2).replaceAll(aliceProject, "<alice-project>").replaceAll(bobProject, "<bob-project>");
      fs.writeFileSync(process.env.QA_CONFIGS_BEHAVIOUR_OUT, text);
    }
    expect(out.scoped).toMatchObject({ bobGet: null, bobList: [], bobUpdate: null, bobDelete: false });
    expect((out.listAfterUpdate as { name: string }[]).map((c) => c.name)).toEqual(["two v2", "three", "one"]);
  });
});
