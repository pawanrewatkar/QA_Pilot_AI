import fs from "node:fs";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeCrawlUrl } from "@/lib/crawler/normalize";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { generateReportBundle } from "@/lib/reports/generate";
import { PlaywrightPdfRenderer } from "@/lib/reports/pdf";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { executeRun } from "@/worker/test-engine/run-executor";
import { startFixtureSite, type FixtureSite } from "../fixtures/site-server";
import { createTestDb, makeTempDir, projectInput } from "../helpers";
import { browserInstalled, INTEGRATION_TIMEOUT } from "./helpers";

const MODULES = ["ui", "accessibility", "seo", "console", "network", "links"];
const PATHS = ["/ui-issues", "/shop"];

describe.skipIf(!browserInstalled("chromium"))("bugs, reports and regression from real runs (Chromium)", () => {
  let site: FixtureSite;
  let db: LocalDatabaseProvider;
  let root: string;
  let storage: LocalStorageProvider;
  let projectId = "";
  const runIds: string[] = [];

  beforeAll(async () => {
    site = await startFixtureSite();
    db = createTestDb();
    root = makeTempDir();
    storage = new LocalStorageProvider(root);
    const project = await db.projects.create(projectInput({ websiteUrl: `${site.origin}/` }));
    projectId = project.id;
    const pageIds: string[] = [];
    for (const path of PATHS) pageIds.push((await db.pages.addManual(project.id, `${site.origin}${path}`, normalizeCrawlUrl(`${site.origin}${path}`)!)).page.id);
    for (const name of ["First", "Second"]) {
      const run = await db.testRuns.createAndEnqueue({
        projectId: project.id, configurationId: null, name, modules: MODULES, browsers: ["chromium"], viewports: ["desktop-1440x900"], pageIds, configurationName: null,
        options: { allowFormSubmission: false, maxLinksPerPage: 30, navigationTimeoutMs: 20_000 },
      });
      const summary = await executeRun(run.id, { store: new SqliteEngineStore(db.sqlite), storage, log: () => undefined });
      expect(summary.status).toBe("COMPLETED");
      runIds.push(run.id);
    }
  }, INTEGRATION_TIMEOUT * 3);

  afterAll(async () => {
    await site?.close();
    await db?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates one bug per verified failure, merges the second run's recurrences and links evidence", async () => {
    const fails = await db.testResults.countByRun(runIds[0], { status: "FAIL" });
    expect(fails).toBeGreaterThan(0);
    const bugs = await db.bugs.list({ projectId, limit: 1000 });
    expect(bugs.length).toBeGreaterThan(0);
    expect(bugs.length).toBeLessThanOrEqual(fails);
    // The second run saw the same failures: no new bugs, every bug observed twice.
    expect(bugs.every((b) => b.firstSeenRunId === runIds[0])).toBe(true);
    expect(bugs.filter((b) => b.occurrenceCount === 2).length).toBeGreaterThan(0);
    const withShot = await Promise.all(bugs.map((b) => db.bugs.getDetail(b.id)));
    const screenshots = withShot.flatMap((d) => d!.evidence.filter((e) => e.type === "SCREENSHOT"));
    expect(screenshots.length).toBeGreaterThan(0);
    expect(screenshots.some((e) => e.screenshotKind === "FULL_PAGE")).toBe(true);
    for (const e of screenshots.slice(0, 5)) expect(await storage.exists(e.storageKey!)).toBe(true);
    for (const d of withShot) {
      expect(d!.code).toMatch(/^BUG-\d{4}$/);
      expect(d!.expectedResult).toBeTruthy();
      expect(d!.actualResult).toBeTruthy();
      expect(d!.stepsToReproduce).toContain("Open ");
    }
  });

  it("compares the two runs by stable identity", async () => {
    const cmp = (await db.history.compare(runIds[1], runIds[0]))!;
    expect(cmp.counts.STILL_FAILING).toBeGreaterThan(0);
    expect(cmp.bugs.new).toHaveLength(0);
    expect(cmp.bugs.existing.length).toBeGreaterThan(0);
    const history = await db.history.listRuns({ projectId });
    expect(history.map((h) => h.name)).toEqual(["Second", "First"]);
    expect(history[0].bugs).toBeGreaterThan(0);
  });

  it("generates PDF, HTML and both Excel reports from the run", async () => {
    const bundle = await db.reports.requestBundle(runIds[1]);
    const outcome = await generateReportBundle(db.sqlite, storage, bundle.id, new PlaywrightPdfRenderer());
    expect(outcome.files.map((f) => [f.kind, f.status, f.error ?? ""])).toEqual([
      ["TESTING_EXCEL", "READY", ""],
      ["BUG_EXCEL", "READY", ""],
      ["HTML", "READY", ""],
      ["PDF", "READY", ""],
    ]);
    const read = async (kind: string) => (await storage.get((await db.reports.getFile(bundle.id, kind))!.storageKey))!;
    const pdf = await read("PDF");
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    const html = new TextDecoder().decode(await read("HTML"));
    expect(html).toContain("BUG-0001");
    expect(html).toContain("© Pawan Rewatkar. All Rights Reserved.");
    expect(html).toContain("data:image/png;base64,");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await read("TESTING_EXCEL")) as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Accessibility")!.rowCount).toBeGreaterThan(1);
    const bugs = new ExcelJS.Workbook();
    await bugs.xlsx.load(Buffer.from(await read("BUG_EXCEL")) as unknown as ArrayBuffer);
    expect(bugs.getWorksheet("Bug Report")!.getRow(2).getCell(1).value).toMatch(/^BUG-/);
    const file = await db.reports.getFile(bundle.id, "TESTING_EXCEL");
    expect(file!.fileName).toMatch(/^QA_Testing_Report_127\.0\.0\.1_\d{4}-\d{2}-\d{2}\.xlsx$/);
  }, INTEGRATION_TIMEOUT);
});
