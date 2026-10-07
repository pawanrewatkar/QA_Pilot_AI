import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bugFingerprint, classifySeverity, priorityFor } from "@/lib/bugs/classify";
import { DeterministicDuplicateDetector } from "@/lib/bugs/duplicates";
import { createBugsForRun } from "@/lib/bugs/engine";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { classifyPair, compareFindingSets, comparePerformance, compareResults, type KeyedResult } from "@/lib/regression/compare";
import { loadReportData, reportFileNames } from "@/lib/reports/data";
import { buildBugExcel, buildTestingExcel } from "@/lib/reports/excel";
import { generateReportBundle } from "@/lib/reports/generate";
import { renderReportHtml } from "@/lib/reports/html";
import type { PdfRenderer } from "@/lib/reports/pdf";
import { maskEmail, redactText } from "@/lib/reports/redact";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { detail } from "@/lib/testing/details";
import { finalizeOutcome, outcome, type CaseSpec } from "@/lib/testing/outcome";
import type { BrowserName, PageRecord, Project } from "@/types";
import { createTestDb, makeTempDir, projectInput } from "./helpers";

const VIEWPORT = "desktop-1366x768";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const linkSpec: CaseSpec = { key: "links:header:/pricing", module: "links", title: "Header link “Pricing” resolves", section: "Header", scenarioType: "FUNCTIONAL", feature: "Links", element: "a[href='/pricing']", steps: ["Request the link target"], expected: "The link target returns 2xx/3xx" };
const seoSpec: CaseSpec = { key: "seo:title", module: "seo", title: "Page title length", section: "SEO", scenarioType: "FUNCTIONAL", feature: "SEO", element: "title", steps: ["Read <title>"], expected: "10–60 characters" };
const consoleSpec: CaseSpec = { key: "console:errors", module: "console", title: "No console errors", section: "Page", scenarioType: "FUNCTIONAL", feature: "Console", element: "page", steps: ["Load page"], expected: "No uncaught errors" };

interface Seeded {
  db: LocalDatabaseProvider;
  store: SqliteEngineStore;
  project: Project;
  page: PageRecord;
}

async function seed(db: LocalDatabaseProvider): Promise<Seeded> {
  const project = await db.projects.create(projectInput({ name: "Acme", websiteUrl: "https://www.acme.test/" }));
  const { page } = await db.pages.addManual(project.id, "https://www.acme.test/", "https://www.acme.test/");
  return { db, store: new SqliteEngineStore(db.sqlite), project, page };
}

type Status = "PASS" | "FAIL" | "WARNING" | "NOT EXECUTED";

/** Creates a finished run with one result per spec, with the given statuses. */
async function runWith(s: Seeded, statuses: { spec: CaseSpec; status: Status; actual?: string }[], options: { browser?: BrowserName; name?: string; screenshot?: boolean } = {}) {
  const browser = options.browser ?? "chromium";
  const run = await s.db.testRuns.createAndEnqueue({ projectId: s.project.id, configurationId: null, name: options.name ?? null, modules: [...new Set(statuses.map((x) => x.spec.module))], browsers: [browser], viewports: [VIEWPORT], pageIds: [s.page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 } });
  s.db.sqlite.prepare("UPDATE jobs SET status = 'COMPLETED'").run();
  s.store.markRunRunning(run.id, 1);
  const rp = s.store.ensureRunPage(run.id, s.page.id);
  let shotKey: string | null = null;
  if (options.screenshot !== false) {
    shotKey = `runs/${run.id}/${s.page.id}/${browser}-${VIEWPORT}/01-viewport.png`;
    s.store.saveScreenshot({ runId: run.id, pageId: s.page.id, storageKey: shotKey, browser, viewport: VIEWPORT, width: 1366, height: 768, kind: "VIEWPORT", label: "Broken link" });
  }
  for (const x of statuses) {
    const actual = x.actual ?? `${x.status} observed`;
    const o =
      x.status === "PASS"
        ? outcome.pass(x.spec, actual, ["verified"], x.spec.module === "seo" ? { details: [detail("seo_results", { check_key: "title", status: "PASS", observed_value: "Acme", message: "ok", expected: "10–60" })] } : {})
        : x.status === "FAIL"
          ? outcome.fail(x.spec, actual, [{ type: "http", label: "HTTP", content: "GET https://www.acme.test/pricing → 404" }, ...(shotKey ? [{ type: "screenshot" as const, label: "Screenshot", storageKey: shotKey }] : [])])
          : x.status === "WARNING"
            ? outcome.warn(x.spec, actual)
            : outcome.notExecuted(x.spec, actual);
    s.store.recordOutcome({ runId: run.id, projectId: s.project.id, pageId: s.page.id, pageUrl: s.page.url, runPageId: rp, browser, viewport: VIEWPORT, outcome: finalizeOutcome(o) });
  }
  s.store.finishRunPage(rp, "COMPLETED", null);
  s.store.finishRun(run.id, "COMPLETED", null);
  return { runId: run.id, shotKey };
}

// ---------------------------------------------------------------- classification & duplicates

describe("bug classification", () => {
  it("fingerprints by normalised page and case identity, independent of run-specific page id", () => {
    expect(bugFingerprint("https://acme.test/a/", "page1|links:x")).toBe(bugFingerprint("https://acme.test/a", "page2|links:x"));
    expect(bugFingerprint("https://acme.test/a", "p|links:x")).not.toBe(bugFingerprint("https://acme.test/b", "p|links:x"));
    expect(bugFingerprint("https://acme.test/a", "p|links:x")).not.toBe(bugFingerprint("https://acme.test/a", "p|links:y"));
  });

  it("assigns severity by deterministic rules with a reason", () => {
    const base = { caseKey: "x", title: "t", section: null, actual: "", viewport: null, pageType: null, axeImpact: null, httpStatus: null };
    expect(classifySeverity({ ...base, module: "page-load", httpStatus: 503 }).severity).toBe("CRITICAL");
    expect(classifySeverity({ ...base, module: "ecommerce", caseKey: "ecommerce:add-to-cart" }).severity).toBe("CRITICAL");
    expect(classifySeverity({ ...base, module: "links", section: "Header" }).severity).toBe("HIGH");
    expect(classifySeverity({ ...base, module: "links", caseKey: "links:mailto:x" }).severity).toBe("LOW");
    const a11y = classifySeverity({ ...base, module: "accessibility", axeImpact: "critical" });
    expect(a11y.severity).toBe("HIGH");
    expect(a11y.reason.length).toBeGreaterThan(5);
  });

  it("derives priority from severity and bumps key pages", () => {
    expect(priorityFor("CRITICAL", null).priority).toBe("P0");
    expect(priorityFor("MEDIUM", "OTHER").priority).toBe("P2");
    expect(priorityFor("MEDIUM", "HOMEPAGE").priority).toBe("P1");
    expect(priorityFor("LOW", "HOMEPAGE").priority).toBe("P3");
  });

  it("detects duplicates by fingerprint and only relates (never merges) similar bugs", () => {
    const d = new DeterministicDuplicateDetector();
    const cand = { fingerprint: "f1", pageUrl: "u", testType: "ui", selector: ".hero", element: null };
    const matches = d.find(cand, [
      { id: "a", fingerprint: "f1", pageUrl: "u", testType: "ui", selector: null, element: null },
      { id: "b", fingerprint: "f2", pageUrl: "u", testType: "ui", selector: ".hero", element: null },
      { id: "c", fingerprint: "f3", pageUrl: "u", testType: "seo", selector: ".hero", element: null },
    ]);
    expect(matches).toEqual([
      { bugId: "a", kind: "duplicate", reason: expect.any(String) },
      { bugId: "b", kind: "related", reason: expect.any(String) },
    ]);
  });
});

describe("redaction", () => {
  it("removes secrets, tokens, card numbers and masks emails", () => {
    const out = redactText(
      "POST https://u:p@acme.test/login?token=abc123&page=2 password=hunter2 Authorization: Bearer abcdefghijklmnop eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk card 4111 1111 1111 1111 mail jane.doe@example.com",
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("4111 1111 1111 1111");
    expect(out).not.toContain("jane.doe@");
    expect(out).toContain("page=2");
    expect(out).toContain("[redacted-jwt]");
    expect(maskEmail("jane@example.com")).toBe("j***@example.com");
  });
});

// ---------------------------------------------------------------- bug engine

describe("bug engine", () => {
  let db: LocalDatabaseProvider;
  let s: Seeded;
  beforeEach(async () => {
    db = createTestDb();
    s = await seed(db);
  });
  afterEach(async () => db.close());

  it("creates bugs only from verified failures, with evidence and the required fields", async () => {
    const { runId, shotKey } = await runWith(s, [
      { spec: linkSpec, status: "FAIL", actual: "GET /pricing returned 404; test password=hunter2" },
      { spec: seoSpec, status: "WARNING" },
      { spec: consoleSpec, status: "NOT EXECUTED" },
    ]);
    // The run executor creates bugs at the end of a run; tests call the engine directly.
    const summary = createBugsForRun(db.sqlite, runId);
    expect(summary).toMatchObject({ failures: 1, created: 1, updated: 0 });

    const bugs = await db.bugs.list({ projectId: s.project.id });
    expect(bugs).toHaveLength(1);
    const bug = (await db.bugs.getDetail(bugs[0].id))!;
    expect(bug.code).toBe("BUG-0001");
    expect(bug).toMatchObject({ status: "OPEN", testType: "links", section: "Header", scenarioType: "FUNCTIONAL", browser: "chromium", viewport: VIEWPORT, severity: "HIGH", screenshotKey: shotKey });
    expect(["P0", "P1"]).toContain(bug.priority);
    expect(bug.title).toContain("Pricing");
    expect(bug.expectedResult).toBe(linkSpec.expected);
    expect(bug.actualResult).not.toContain("hunter2");
    expect(bug.stepsToReproduce).toContain("Open https://www.acme.test/");
    expect(bug.evidence.some((e) => e.type === "SCREENSHOT" && e.storageKey === shotKey && e.screenshotKind === "VIEWPORT")).toBe(true);
    expect(bug.evidence.every((e) => e.testRunId === runId)).toBe(true);
    expect(bug.occurrences).toHaveLength(1);
    expect(bug.history[0]).toMatchObject({ toStatus: "OPEN", source: "ENGINE" });
  });

  it("is idempotent and merges recurrences into the same bug", async () => {
    const r1 = await runWith(s, [{ spec: linkSpec, status: "FAIL" }]);
    createBugsForRun(db.sqlite, r1.runId);
    const again = createBugsForRun(db.sqlite, r1.runId);
    expect(again.created).toBe(0);
    let [bug] = await db.bugs.list();
    expect(bug.occurrenceCount).toBe(1);
    expect((await db.bugs.getDetail(bug.id))!.evidence.filter((e) => e.type === "SCREENSHOT" && e.screenshotKind === "VIEWPORT")).toHaveLength(1);

    const r2 = await runWith(s, [{ spec: linkSpec, status: "FAIL" }], { browser: "firefox" });
    const sum2 = createBugsForRun(db.sqlite, r2.runId);
    expect(sum2).toMatchObject({ created: 0, updated: 1 });
    [bug] = await db.bugs.list();
    expect(await db.bugs.count()).toBe(1);
    expect(bug.occurrenceCount).toBe(2);
    expect(bug.firstSeenRunId).toBe(r1.runId);
    expect(bug.lastSeenRunId).toBe(r2.runId);
    expect((await db.bugs.list({ browser: "firefox" })).map((b) => b.id)).toEqual([bug.id]);
    expect(await db.bugs.list({ testRunId: r2.runId })).toHaveLength(1);
  });

  it("never resolves automatically, and reopens a resolved bug when the failure recurs", async () => {
    const r1 = await runWith(s, [{ spec: linkSpec, status: "FAIL" }]);
    createBugsForRun(db.sqlite, r1.runId);
    const [bug] = await db.bugs.list();

    // A later passing run does not change the bug's status.
    const r2 = await runWith(s, [{ spec: linkSpec, status: "PASS" }]);
    createBugsForRun(db.sqlite, r2.runId);
    expect((await db.bugs.getDetail(bug.id))!.status).toBe("OPEN");

    await db.bugs.updateStatus(bug.id, "RESOLVED", "Fixed in deploy 42");
    const r3 = await runWith(s, [{ spec: linkSpec, status: "FAIL" }]);
    const sum = createBugsForRun(db.sqlite, r3.runId);
    expect(sum.reopened).toBe(1);
    const d = (await db.bugs.getDetail(bug.id))!;
    expect(d.status).toBe("REOPENED");
    expect(d.history.map((h) => [h.toStatus, h.source])).toEqual([
      ["OPEN", "ENGINE"],
      ["RESOLVED", "USER"],
      ["REOPENED", "ENGINE"],
    ]);
  });

  it("filters bugs by severity, status, test type, device and search", async () => {
    const r1 = await runWith(s, [{ spec: linkSpec, status: "FAIL" }, { spec: consoleSpec, status: "FAIL" }]);
    createBugsForRun(db.sqlite, r1.runId);
    expect(await db.bugs.count({ testType: "console" })).toBe(1);
    expect(await db.bugs.count({ device: "desktop" })).toBe(2);
    expect(await db.bugs.count({ device: "mobile" })).toBe(0);
    expect(await db.bugs.count({ search: "Pricing" })).toBe(1);
    expect(await db.bugs.count({ search: "BUG-0002" })).toBe(1);
    expect(await db.bugs.count({ status: "CLOSED" })).toBe(0);
    const facets = await db.bugs.facets(s.project.id);
    expect(facets.testTypes.sort()).toEqual(["console", "links"]);
    expect(facets.browsers).toEqual(["chromium"]);
  });
});

// ---------------------------------------------------------------- regression

describe("regression comparison", () => {
  it("classifies status pairs without ever inferring a fix", () => {
    expect(classifyPair("PASS", "FAIL").category).toBe("NEW");
    expect(classifyPair(null, "FAIL").category).toBe("NEW");
    expect(classifyPair("FAIL", "FAIL").category).toBe("STILL_FAILING");
    expect(classifyPair("FAIL", "PASS").category).toBe("RESOLVED");
    expect(classifyPair("FAIL", "NOT EXECUTED").category).toBe("UNABLE_TO_COMPARE");
    expect(classifyPair("FAIL", null).category).toBe("UNABLE_TO_COMPARE");
    expect(classifyPair("FAIL", "WARNING").category).toBe("CHANGED");
    expect(classifyPair("PASS", "WARNING").category).toBe("CHANGED");
    expect(classifyPair("PASS", "PASS").category).toBe("UNCHANGED");
    expect(classifyPair("NOT EXECUTED", "PASS").category).toBe("UNABLE_TO_COMPARE");
  });

  it("matches results by case key, browser and viewport", () => {
    const r = (caseKey: string, status: KeyedResult["status"], browser = "chromium"): KeyedResult => ({ caseKey, status, browser, viewport: "v", title: caseKey, module: "m", pageUrl: null });
    const out = compareResults([r("a", "FAIL"), r("b", "PASS"), r("c", "FAIL", "firefox")], [r("a", "PASS"), r("b", "FAIL"), r("c", "FAIL", "chromium")]);
    const by = Object.fromEntries(out.map((x) => [x.key, x.category]));
    expect(by).toEqual({ "a|chromium|v": "RESOLVED", "b|chromium|v": "NEW", "c|firefox|v": "UNABLE_TO_COMPARE", "c|chromium|v": "NEW" });
  });

  it("ignores performance noise and refuses to compare different sources", () => {
    const p = (score: number, lcp: number, source = "LOCAL_LIGHTHOUSE") => ({ pageUrl: "u", formFactor: "desktop", source, performanceScore: score, accessibilityScore: null, lcpMs: lcp, cls: null, tbtMs: null });
    expect(comparePerformance([p(0.9, 2000)], [p(0.88, 2050)])[0].overall).toBe("UNCHANGED");
    expect(comparePerformance([p(0.9, 2000)], [p(0.7, 3500)])[0].overall).toBe("REGRESSED");
    expect(comparePerformance([p(0.6, 4000)], [p(0.9, 2000)])[0].overall).toBe("IMPROVED");
    expect(comparePerformance([p(0.9, 2000, "LOCAL_BROWSER")], [p(0.5, 5000)])[0].overall).toBe("UNABLE_TO_COMPARE");
  });

  it("only reports fixed findings for scopes examined in both runs", () => {
    const prev = new Map([["s1", new Set(["color-contrast", "label"])], ["s2", new Set(["image-alt"])]]);
    const curr = new Map([["s1", new Set(["label", "region"])]]);
    const out = compareFindingSets(prev, curr, new Set(["s1", "s2"]), new Set(["s1"]));
    expect(out.find((x) => x.scope === "s1")).toMatchObject({ newFindings: ["region"], fixedFindings: ["color-contrast"], persistingFindings: ["label"], comparable: true });
    expect(out.find((x) => x.scope === "s2")).toMatchObject({ fixedFindings: [], comparable: false });
  });

  it("compares two stored runs: results, new and existing bugs, history rows", async () => {
    const db = createTestDb();
    const s = await seed(db);
    const r1 = await runWith(s, [{ spec: linkSpec, status: "FAIL" }, { spec: seoSpec, status: "PASS" }, { spec: consoleSpec, status: "FAIL" }], { name: "Baseline" });
    createBugsForRun(db.sqlite, r1.runId);
    const r2 = await runWith(s, [{ spec: linkSpec, status: "FAIL" }, { spec: seoSpec, status: "FAIL" }, { spec: consoleSpec, status: "PASS" }], { name: "Release" });
    createBugsForRun(db.sqlite, r2.runId);

    expect(await db.history.previousRunId(r2.runId)).toBe(r1.runId);
    const cmp = (await db.history.compare(r2.runId, r1.runId))!;
    expect(cmp.counts).toMatchObject({ NEW: 1, STILL_FAILING: 1, RESOLVED: 1 });
    expect(cmp.bugs.new.map((b) => b.testType)).toEqual(["seo"]);
    expect(cmp.bugs.existing.map((b) => b.testType)).toEqual(["links"]);
    expect(cmp.bugs.notObserved.map((b) => [b.testType, b.status])).toEqual([["console", "OPEN"]]);

    const history = await db.history.listRuns({ projectId: s.project.id });
    expect(history.map((h) => h.name)).toEqual(["Release", "Baseline"]);
    expect(history[0]).toMatchObject({ pages: 1, totalTests: 3, bugs: 2, newBugs: 1, seo: { failed: 1, executed: 1 } });
    expect(history[0].counts).toMatchObject({ PASS: 1, FAIL: 2 });
    expect(await db.history.countRuns({ search: "Release" })).toBe(1);
    await db.close();
  });
});

// ---------------------------------------------------------------- reports

describe("reports", () => {
  let db: LocalDatabaseProvider;
  let s: Seeded;
  let runId: string;
  beforeEach(async () => {
    db = createTestDb();
    s = await seed(db);
    ({ runId } = await runWith(s, [
      { spec: linkSpec, status: "FAIL", actual: "404 for https://www.acme.test/pricing?token=s3cr3t-value contact jane.doe@example.com" },
      { spec: seoSpec, status: "PASS" },
      { spec: consoleSpec, status: "NOT EXECUTED", actual: "Console capture unavailable" },
    ], { name: "Nightly" }));
    createBugsForRun(db.sqlite, runId);
  });
  afterEach(async () => db.close());

  it("assembles report data from recorded results only, redacted", async () => {
    const data = await loadReportData(db.sqlite, runId);
    expect(data.counts).toMatchObject({ PASS: 1, FAIL: 1, "NOT EXECUTED": 1, WARNING: 0 });
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0]).toMatchObject({ bugs: 1 });
    expect(data.bugs).toHaveLength(1);
    expect(data.details.seo.rows).toHaveLength(1);
    expect(data.details.performance.rows).toHaveLength(0);
    const json = JSON.stringify(data);
    expect(json).not.toContain("s3cr3t-value");
    expect(json).not.toContain("jane.doe@");
    expect(data.copyright).toBe("© Pawan Rewatkar. All Rights Reserved.");
  });

  it("names files after the website and date", () => {
    expect(reportFileNames("https://www.acme.test/", new Date("2026-03-05T10:00:00Z"))).toMatchObject({
      testingExcel: "QA_Testing_Report_acme.test_2026-03-05.xlsx",
      bugExcel: "QA_Bug_Report_acme.test_2026-03-05.xlsx",
    });
  });

  it("builds the testing workbook with every required sheet, frozen headers and filters", async () => {
    const data = await loadReportData(db.sqlite, runId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await buildTestingExcel(data)) as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    for (const required of ["Summary", "Page Wise Testing", "UI Testing", "Functional Testing", "Positive Negative Edge Testing", "Links", "Performance", "Accessibility", "SEO", "Console & Network", "Content Comparison", "Figma Comparison", "Typography"]) {
      expect(names).toContain(required);
    }
    const links = wb.getWorksheet("Links")!;
    expect(links.getRow(1).getCell(11).value).toBe("Status");
    expect(links.getRow(2).getCell(11).value).toBe("FAIL");
    expect(links.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(links.autoFilter).toBeTruthy();
    expect(String(wb.getWorksheet("Performance")!.getRow(2).getCell(1).value)).toContain("No data recorded");
    const summary = wb.getWorksheet("Summary")!;
    const values = summary.getSheetValues().flat().map(String);
    expect(values).toContain("© Pawan Rewatkar. All Rights Reserved.");
  });

  it("builds the bug workbook", async () => {
    const data = await loadReportData(db.sqlite, runId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await buildBugExcel(data)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Bug Report", "Bug Summary", "Testing Type Bug Count"]);
    const sheet = wb.getWorksheet("Bug Report")!;
    const headers = (sheet.getRow(1).values as unknown[]).filter(Boolean);
    for (const h of ["Bug ID", "Title", "Page Name", "Page URL", "Section", "Test Type", "Scenario Type", "Device", "Browser", "Severity", "Priority", "Status", "Expected Result", "Actual Result", "Steps To Reproduce", "Element", "Selector", "Technical Details", "Screenshot Reference", "Created Date"]) {
      expect(headers).toContain(h);
    }
    expect(sheet.getRow(2).getCell(1).value).toBe("BUG-0001");
    expect(wb.getWorksheet("Testing Type Bug Count")!.getRow(2).getCell(2).value).toBe(1);
  });

  it("renders a standalone HTML report with branding, filters and embedded screenshots", async () => {
    const data = await loadReportData(db.sqlite, runId);
    const key = data.screenshots[0].key;
    const html = renderReportHtml(data, { mode: "standalone", images: new Map([[key, "data:image/png;base64,AAAA"]]) });
    expect(html).toContain("QA Pilot AI");
    expect(html).toContain("© Pawan Rewatkar. All Rights Reserved.");
    expect(html).toContain('data-search');
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("BUG-0001");
    expect(html).not.toContain("s3cr3t-value");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    const print = renderReportHtml(data, { mode: "print", images: new Map() });
    expect(print).not.toContain("<script>");
    expect(print).toContain('class="cover"');
  });

  it("generates a bundle of four files, isolating a PDF failure", async () => {
    const storage = new LocalStorageProvider(makeTempDir());
    const data = await loadReportData(db.sqlite, runId);
    await storage.put(data.screenshots[0].key, new Uint8Array(PNG));
    const bundle = await db.reports.requestBundle(runId);
    const job = db.sqlite.prepare("SELECT type, payload FROM jobs WHERE type = 'report.generate'").get() as { type: string; payload: string };
    expect(JSON.parse(job.payload)).toEqual({ reportBundleId: bundle.id });

    const okPdf: PdfRenderer = { render: async (html) => new TextEncoder().encode(`%PDF-1.4 ${html.length}`) };
    const out = await generateReportBundle(db.sqlite, storage, bundle.id, okPdf);
    expect(out.status).toBe("READY");
    const ready = (await db.reports.getBundle(bundle.id))!;
    expect(ready.status).toBe("READY");
    expect(ready.files.map((f) => [f.kind, f.status])).toEqual([["PDF", "READY"], ["HTML", "READY"], ["TESTING_EXCEL", "READY"], ["BUG_EXCEL", "READY"]]);
    const html = await db.reports.getFile(bundle.id, "HTML");
    const bytes = new TextDecoder().decode((await storage.get(html!.storageKey))!);
    expect(bytes).toContain(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);

    const failing = await db.reports.requestBundle(runId);
    const out2 = await generateReportBundle(db.sqlite, storage, failing.id, { render: async () => { throw new Error("Chromium is not installed"); } });
    expect(out2.status).toBe("READY");
    const partial = (await db.reports.getBundle(failing.id))!;
    expect(partial.files.find((f) => f.kind === "PDF")).toMatchObject({ status: "FAILED", errorMessage: "Chromium is not installed" });
    expect(await db.reports.getFile(failing.id, "PDF")).toBeNull();
    expect(await db.reports.countBundles({ projectId: s.project.id })).toBe(2);

    expect(await db.reports.deleteBundle(failing.id)).toBe(true);
    expect(await db.reports.countBundles()).toBe(1);
  });

  it("refuses to report on unfinished runs and fails the bundle, not the run, when the worker dies", async () => {
    const pending = await db.testRuns.createAndEnqueue({ projectId: s.project.id, configurationId: null, name: null, modules: ["seo"], browsers: ["chromium"], viewports: [VIEWPORT], pageIds: [s.page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 } });
    await expect(db.reports.requestBundle(pending.id)).rejects.toThrow(/finished/);

    const bundle = await db.reports.requestBundle(runId);
    db.sqlite.prepare("UPDATE jobs SET status = 'RUNNING', locked_by = 'dead-worker' WHERE type = 'report.generate'").run();
    expect(s.store.recoverAbandonedWork(1000)).toBeGreaterThan(0);
    expect((await db.reports.getBundle(bundle.id))!.status).toBe("FAILED");
    expect((await db.testRuns.getById(runId))!.status).toBe("COMPLETED");
  });
});
