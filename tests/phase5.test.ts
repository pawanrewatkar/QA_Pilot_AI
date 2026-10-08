import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBugsForRun } from "@/lib/bugs/engine";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { EXPECTED_TABLES } from "@/lib/database/schema";
import { generateReportBundle } from "@/lib/reports/generate";
import { deleteProject } from "@/lib/services/projects";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { finalizeOutcome, outcome, type CaseSpec } from "@/lib/testing/outcome";
import type { TestRunOptions } from "@/types";
import { executeRun } from "@/worker/test-engine/run-executor";
import { createTestDb, makeTempDir, projectInput } from "./helpers";

const VIEWPORT = "desktop-1366x768";
const failSpec: CaseSpec = { key: "links:footer:/x", module: "links", title: "Footer link resolves", section: "Footer", scenarioType: "FUNCTIONAL", feature: "Links", element: "a", steps: [], expected: "2xx" };
const baseOptions: TestRunOptions = { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 };

describe("project deletion and run isolation", () => {
  let db: LocalDatabaseProvider;
  let storage: LocalStorageProvider;
  beforeEach(() => {
    db = createTestDb();
    storage = new LocalStorageProvider(makeTempDir());
  });
  afterEach(async () => db.close());

  /** A project with two finished runs, a bug, evidence files and a generated report. */
  async function seedProject(name: string) {
    const project = await db.projects.create(projectInput({ name, websiteUrl: `https://${name}.test/` }));
    const { page } = await db.pages.addManual(project.id, `https://${name}.test/`, `https://${name}.test/`);
    const store = new SqliteEngineStore(db.sqlite);
    const runIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const run = await db.testRuns.createAndEnqueue({ projectId: project.id, configurationId: null, name: `${name} ${i}`, modules: ["links"], browsers: ["chromium"], viewports: [VIEWPORT], pageIds: [page.id], configurationName: null, options: baseOptions });
      db.sqlite.prepare("UPDATE jobs SET status = 'COMPLETED' WHERE json_extract(payload, '$.testRunId') = ?").run(run.id);
      store.markRunRunning(run.id, 1);
      const rp = store.ensureRunPage(run.id, page.id);
      const key = `runs/${run.id}/${page.id}/shot.png`;
      await storage.put(key, new Uint8Array([1, 2, 3]));
      store.saveScreenshot({ runId: run.id, pageId: page.id, storageKey: key, browser: "chromium", viewport: VIEWPORT, width: 1, height: 1 });
      store.recordOutcome({ runId: run.id, projectId: project.id, pageId: page.id, pageUrl: page.url, runPageId: rp, browser: "chromium", viewport: VIEWPORT, outcome: finalizeOutcome(outcome.fail(failSpec, "404", [{ type: "screenshot", label: "s", storageKey: key }])) });
      store.finishRunPage(rp, "COMPLETED", null);
      store.finishRun(run.id, "COMPLETED", null);
      createBugsForRun(db.sqlite, run.id);
      runIds.push(run.id);
    }
    const bundle = await db.reports.requestBundle(runIds[1]);
    await generateReportBundle(db.sqlite, storage, bundle.id, { render: async () => new TextEncoder().encode("%PDF-1.4") });
    return { project, runIds, bundle };
  }

  it("keeps each run's results, evidence and test cases separate", async () => {
    const { runIds } = await seedProject("acme");
    for (const id of runIds) {
      const results = await db.testResults.listByRun(id);
      expect(results).toHaveLength(1);
      expect(results[0].testRunId).toBe(id);
      expect(results[0].evidence[0].storageKey).toContain(`runs/${id}/`);
    }
    const caseRuns = db.sqlite.prepare("SELECT DISTINCT test_run_id FROM test_cases").all() as { test_run_id: string }[];
    expect(caseRuns.map((r) => r.test_run_id).sort()).toEqual([...runIds].sort());
    // Recurring failure: one bug, observed in both runs.
    const [bug] = await db.bugs.list();
    expect(bug.occurrenceCount).toBe(2);
  });

  it("deletes every record and stored file of a project without touching other projects", async () => {
    const doomed = await seedProject("doomed");
    const kept = await seedProject("kept");
    // A queued run for the deleted project must not be picked up later.
    const queued = await db.testRuns.createAndEnqueue({ projectId: doomed.project.id, configurationId: null, name: "queued", modules: ["links"], browsers: ["chromium"], viewports: [VIEWPORT], pageIds: [], configurationName: null, options: baseOptions });

    const deps = { db, storage, maxUploadBytes: 1_000_000 };
    expect(await deleteProject(deps, doomed.project.id)).toBe(true);

    expect(db.sqlite.pragma("foreign_key_check")).toEqual([]);
    for (const table of EXPECTED_TABLES) {
      const cols = (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (cols.includes("project_id")) expect((db.sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?`).get(doomed.project.id) as { c: number }).c, table).toBe(0);
      if (cols.includes("test_run_id")) {
        for (const id of [...doomed.runIds, queued.id]) expect((db.sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE test_run_id = ?`).get(id) as { c: number }).c, table).toBe(0);
      }
    }
    expect(db.sqlite.prepare("SELECT status FROM jobs WHERE json_extract(payload, '$.testRunId') = ?").get(queued.id)).toEqual({ status: "CANCELLED" });
    const doomedFiles = await Promise.all([...doomed.runIds.map((id) => storage.deletePrefix(`runs/${id}`)), storage.deletePrefix(`reports/${doomed.bundle.id}`)]);
    expect(doomedFiles.every((n) => n === 0)).toBe(true);

    // The other project is intact.
    expect(await db.testResults.countByRun(kept.runIds[0])).toBe(1);
    expect(await db.bugs.count({ projectId: kept.project.id })).toBe(1);
    expect((await db.reports.getBundle(kept.bundle.id))!.files.length).toBe(4);
    expect(await storage.exists(`runs/${kept.runIds[0]}/${(await db.pages.list({ projectId: kept.project.id }))[0].id}/shot.png`)).toBe(true);
  });
});

describe("run execution integration", () => {
  let db: LocalDatabaseProvider;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(async () => db.close());

  async function queuedRun(options: TestRunOptions, browsers: ("chromium" | "firefox")[] = ["chromium"]) {
    const project = await db.projects.create(projectInput());
    const { page } = await db.pages.addManual(project.id, "https://example.com/", "https://example.com/");
    return db.testRuns.createAndEnqueue({ projectId: project.id, configurationId: null, name: null, modules: ["links", "seo"], browsers, viewports: [VIEWPORT], pageIds: [page.id], configurationName: null, options });
  }

  it("records NOT EXECUTED for a browser that cannot start and still completes the run", async () => {
    const run = await queuedRun(baseOptions, ["chromium", "firefox"]);
    const summary = await executeRun(run.id, {
      store: new SqliteEngineStore(db.sqlite),
      storage: new LocalStorageProvider(makeTempDir()),
      log: () => undefined,
      launch: async () => {
        throw new Error("Executable doesn't exist");
      },
    });
    expect(summary.status).toBe("COMPLETED");
    const results = await db.testResults.listByRun(run.id);
    expect(results.length).toBeGreaterThan(0);
    expect(new Set(results.map((r) => r.browser))).toEqual(new Set(["chromium", "firefox"]));
    expect(results.every((r) => r.status === "NOT EXECUTED")).toBe(true);
    expect(await db.bugs.count()).toBe(0);
  });

  it("queues the report formats selected for the run when it completes", async () => {
    const run = await queuedRun({ ...baseOptions, reports: { formats: ["PDF", "EXCEL"] } });
    await executeRun(run.id, { store: new SqliteEngineStore(db.sqlite), storage: new LocalStorageProvider(makeTempDir()), log: () => undefined, launch: async () => { throw new Error("no browser"); } });
    const bundles = await db.reports.listBundles({ testRunId: run.id });
    expect(bundles).toHaveLength(1);
    const job = db.sqlite.prepare("SELECT payload FROM jobs WHERE type = 'report.generate'").get() as { payload: string };
    expect(JSON.parse(job.payload)).toEqual({ reportBundleId: bundles[0].id, kinds: ["PDF", "TESTING_EXCEL", "BUG_EXCEL"] });

    const storage = new LocalStorageProvider(makeTempDir());
    await generateReportBundle(db.sqlite, storage, bundles[0].id, { render: async () => new TextEncoder().encode("%PDF-1.4") }, ["PDF", "TESTING_EXCEL", "BUG_EXCEL"]);
    expect((await db.reports.getBundle(bundles[0].id))!.files.map((f) => f.kind)).toEqual(["PDF", "TESTING_EXCEL", "BUG_EXCEL"]);
  });

  it("does not queue a report when none was selected", async () => {
    const run = await queuedRun(baseOptions);
    await executeRun(run.id, { store: new SqliteEngineStore(db.sqlite), storage: new LocalStorageProvider(makeTempDir()), log: () => undefined, launch: async () => { throw new Error("no browser"); } });
    expect(await db.reports.countBundles()).toBe(0);
  });
});

describe("schema", () => {
  it("indexes every foreign-key column so cascades and per-run lookups never scan whole tables", () => {
    const db = createTestDb();
    const missing: string[] = [];
    const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) {
      const leading = (db.sqlite.prepare(`PRAGMA index_list(${t})`).all() as { name: string }[]).map((i) => (db.sqlite.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[])[0]?.name);
      for (const fk of db.sqlite.prepare(`PRAGMA foreign_key_list(${t})`).all() as { from: string }[]) if (!leading.includes(fk.from)) missing.push(`${t}.${fk.from}`);
    }
    expect(missing).toEqual([]);
    void db.close();
  });
});
