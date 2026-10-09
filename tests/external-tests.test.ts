import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBugsForRun } from "@/lib/bugs/engine";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { judge, type Observation, type PageFacts } from "@/lib/external-tests/evaluate";
import { finalizeExternalRun } from "@/lib/external-tests/finalize";
import { detectHumanInteraction, interpretCase, planChecks, targetDevices } from "@/lib/external-tests/interpret";
import { detectMapping, validateMapping } from "@/lib/external-tests/mapping";
import { externalSpec } from "@/lib/external-tests/module";
import { planResultColumns } from "@/lib/external-tests/result-columns";
import { DRIVE_UNAVAILABLE, GoogleDriveLinkSourceProvider, LocalPathSourceProvider, parseDriveLink, SourceError } from "@/lib/external-tests/sources";
import { aggregateStatus } from "@/lib/external-tests/status";
import { loadWorkbook, readSheet, toCases, validateWorkbookFile, worksheetNames } from "@/lib/external-tests/workbook";
import { writeResults } from "@/lib/external-tests/writer";
import type { HttpResult } from "@/lib/net/http";
import { inspectDraftSheet, inspectSource, startExternalExecution, type ExternalTestDeps } from "@/lib/services/external-tests";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { finalizeOutcome, outcome } from "@/lib/testing/outcome";
import { createTestDb, makeTempDir, projectInput } from "./helpers";

// ---------------------------------------------------------------- helpers

type Cell = string | number | null;

async function workbook(sheets: Record<string, Cell[][]>, style?: (ws: ExcelJS.Worksheet) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
    style?.(ws);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

async function readBack(bytes: Uint8Array, sheet: string): Promise<string[][]> {
  const wb = await loadWorkbook(bytes);
  const ws = wb.getWorksheet(sheet)!;
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, r) => {
    const cells: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = row.getCell(c).value;
      cells.push(v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? "" : String(v));
    }
    out[r - 1] = cells;
  });
  return out;
}

const HEADERS = ["TC ID", "Scenario", "Steps", "Expected"];
const RUN_DATE = new Date("2026-10-09T10:00:00Z");

// ---------------------------------------------------------------- parsing & mapping

describe("workbook parsing and column mapping", () => {
  it("validates files before parsing", async () => {
    expect(validateWorkbookFile("cases.csv", new Uint8Array([1]), 1000)).toMatchObject({ ok: false });
    expect(validateWorkbookFile("cases.xlsx", new Uint8Array([1, 2, 3, 4]), 1000)).toMatchObject({ ok: false, error: expect.stringContaining("not a valid Excel") });
    expect(validateWorkbookFile("cases.xlsx", new Uint8Array(), 1000)).toMatchObject({ ok: false });
    expect(validateWorkbookFile("cases.xlsx", new Uint8Array(2000).fill(0x50), 1000)).toMatchObject({ ok: false, error: expect.stringContaining("too large") });
    await expect(loadWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]))).rejects.toThrow(/could not be read/);
  });

  it("lists worksheets, finds the header row below a title and ignores empty rows", async () => {
    const bytes = await workbook({
      Notes: [["Read me"]],
      "Regression Suite": [["Acme regression – Q4"], [], HEADERS, ["TC01", "Open home", "Open homepage", "Home page loads"], [], [null, null, null, null], ["TC02", "Login link", "Click Login", "Login page should open"]],
    });
    const wb = await loadWorkbook(bytes);
    expect(worksheetNames(wb)).toEqual(["Notes", "Regression Suite"]);
    const sheet = readSheet(wb, "Regression Suite");
    expect(sheet.headerRow).toBe(3);
    expect(sheet.columns.map((c) => c.header)).toEqual(HEADERS);
    expect(sheet.rows.map((r) => r.rowNumber)).toEqual([4, 7]);
    expect(() => readSheet(wb, "Missing")).toThrow(/does not exist/);
  });

  it("detects columns under different header names and lets the mapping be corrected", () => {
    const cols = (names: string[]) => names.map((header, i) => ({ index: i + 1, header }));
    expect(detectMapping(cols(["Test Case ID", "Test Case", "Test Steps", "Expected Result", "Actual Result", "Status"]))).toEqual({ caseId: 1, title: 2, steps: 3, expected: 4 });
    expect(detectMapping(cols(["ID", "Description", "Steps to Reproduce", "Expected Outcome"]))).toEqual({ caseId: 1, title: 2, steps: 3, expected: 4 });
    expect(detectMapping(cols(["TC ID", "Scenario", "Action", "Expected", "URL"]))).toEqual({ caseId: 1, scenario: 2, steps: 3, expected: 4, url: 5 });
    const missing = validateMapping({ caseId: 1, title: 2 }, cols(["ID", "Name", "Other"]));
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(" ")).toMatch(/Expected Result/);
    const corrected = validateMapping({ caseId: 1, title: 2, expected: 3 }, cols(["ID", "Name", "Other"]));
    expect(corrected).toMatchObject({ ok: true, warnings: [expect.stringMatching(/Steps/)] });
    expect(validateMapping({ title: 2, expected: 2 }, cols(["ID", "Name"])).errors.join(" ")).toMatch(/same column/);
  });

  it("turns mapped rows into test cases and skips rows without a test case", async () => {
    const wb = await loadWorkbook(await workbook({ S: [HEADERS, ["TC01", "Open home", "Open homepage", "Page loads"], ["TC02", "", "Click", "x"]] }));
    const sheet = readSheet(wb, "S");
    expect(toCases(sheet, detectMapping(sheet.columns))).toEqual([
      { rowNumber: 2, caseRef: "TC01", title: "Open home", steps: "Open homepage", expected: "Page loads", url: null, testData: null, preconditions: null },
    ]);
  });
});

// ---------------------------------------------------------------- result columns

describe("result columns never overwrite earlier executions", () => {
  const cols = (names: string[]) => names.map((header, i) => ({ index: i + 1, header }));

  it("creates Actual Result / Status / Date when absent", () => {
    const plan = planResultColumns(cols(HEADERS), () => false, 4);
    expect([plan.set, plan.actual, plan.status, plan.date]).toEqual([1, { header: "Actual Result", index: 5, exists: false }, { header: "Status", index: 6, exists: false }, { header: "Date", index: 7, exists: false }]);
  });

  it("reuses empty result columns", () => {
    const plan = planResultColumns(cols([...HEADERS, "Actual Result", "Status", "Date"]), () => false, 7);
    expect(plan).toMatchObject({ set: 1, actual: { index: 5, exists: true }, status: { index: 6, exists: true }, date: { index: 7, exists: true } });
  });

  it("creates set 2 when set 1 has data, and set 3 when set 2 has data", () => {
    const filled = new Set([5, 6, 7]);
    const plan2 = planResultColumns(cols([...HEADERS, "Actual Result", "Status", "Date"]), (c) => filled.has(c), 7);
    expect(plan2).toMatchObject({ set: 2, actual: { header: "Actual Result 2", index: 8 }, status: { header: "Status 2", index: 9 }, date: { header: "Date 2", index: 10 } });
    const plan3 = planResultColumns(cols([...HEADERS, "Actual Result", "Status", "Date", "Actual Result 2", "Status 2", "Date 2"]), (c) => c >= 5, 10);
    expect(plan3).toMatchObject({ set: 3, actual: { header: "Actual Result 3", index: 11 }, status: { header: "Status 3", index: 12 }, date: { header: "Date 3", index: 13 } });
  });

  it("treats a partially filled set as an earlier execution", () => {
    // Actual Result and Status filled, Date empty: never written into.
    const plan = planResultColumns(cols([...HEADERS, "Actual Result", "Status", "Date"]), (c) => c === 5 || c === 6, 7);
    expect(plan.set).toBe(2);
    // Only a Status column with data exists: the whole first set is considered used.
    expect(planResultColumns(cols([...HEADERS, "Status"]), (c) => c === 5, 5).set).toBe(2);
  });

  it("never uses a column mapped as a test-case input", () => {
    expect(planResultColumns(cols(["ID", "Case", "Expected", "Date"]), () => false, 4, new Set([4])).set).toBe(2);
  });
});

// ---------------------------------------------------------------- Excel output

describe("Excel output", () => {
  const results = [
    { rowNumber: 2, status: "PASS" as const, actual: "Navigated to /login.", executedAt: RUN_DATE },
    { rowNumber: 3, status: "HUMAN INTERACTION" as const, actual: "This test case needs human interaction.", executedAt: RUN_DATE },
  ];

  it("adds results to the existing sheet over three executions without touching earlier results", async () => {
    let bytes = await workbook({ Cases: [HEADERS, ["TC01", "Login", "Click Login", "Login page opens"], ["TC02", "OTP", "Enter OTP", "Logged in"]] });
    const original = await readBack(bytes, "Cases");

    const first = await writeResults(bytes, { sheetName: "Cases", headerRow: 1, mode: "EXISTING_SHEET", results });
    expect(first.columns.set).toBe(1);
    bytes = first.bytes;
    let rows = await readBack(bytes, "Cases");
    expect(rows[0]).toEqual([...HEADERS, "Actual Result", "Status", "Date"]);
    expect(rows[1].slice(4)).toEqual(["Navigated to /login.", "PASS", "2026-10-09"]);

    const second = await writeResults(bytes, { sheetName: "Cases", headerRow: 1, mode: "EXISTING_SHEET", results: [{ ...results[0], status: "FAIL", actual: "Second run" }] });
    expect(second.columns.set).toBe(2);
    rows = await readBack(second.bytes, "Cases");
    expect(rows[0].slice(4)).toEqual(["Actual Result", "Status", "Date", "Actual Result 2", "Status 2", "Date 2"]);
    expect(rows[1].slice(4, 7)).toEqual(["Navigated to /login.", "PASS", "2026-10-09"]);
    expect(rows[1].slice(7, 10)).toEqual(["Second run", "FAIL", "2026-10-09"]);

    const third = await writeResults(second.bytes, { sheetName: "Cases", headerRow: 1, mode: "EXISTING_SHEET", results: [{ ...results[0], actual: "Third run" }] });
    expect(third.columns.set).toBe(3);
    rows = await readBack(third.bytes, "Cases");
    expect(rows[0].slice(10)).toEqual(["Actual Result 3", "Status 3", "Date 3"]);
    expect(rows[1].slice(4, 10)).toEqual(["Navigated to /login.", "PASS", "2026-10-09", "Second run", "FAIL", "2026-10-09"]);
    expect(rows[1].slice(10, 13)).toEqual(["Third run", "PASS", "2026-10-09"]);
    // Original test-case data is unchanged in every version.
    expect(rows.map((r) => r.slice(0, 4))).toEqual(original.map((r) => r.slice(0, 4)));
  });

  it("highlights HUMAN INTERACTION in yellow and keeps formatting", async () => {
    const bytes = await workbook({ Cases: [HEADERS, ["TC01", "Login", "Click Login", "Login page opens"], ["TC02", "OTP", "Enter OTP", "Logged in"]] }, (ws) => {
      ws.getColumn(2).width = 42;
      ws.views = [{ state: "frozen", ySplit: 1 }];
      ws.getRow(1).font = { bold: true };
      ws.autoFilter = "A1:D1";
    });
    const out = await writeResults(bytes, { sheetName: "Cases", headerRow: 1, mode: "EXISTING_SHEET", results });
    const wb = await loadWorkbook(out.bytes);
    const ws = wb.getWorksheet("Cases")!;
    const fillOf = (c: ExcelJS.Cell) => (c.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
    expect(fillOf(ws.getCell("E3"))).toBe("FFFFF59D");
    expect(fillOf(ws.getCell("F3"))).toBe("FFFFF59D");
    expect(fillOf(ws.getCell("F2"))).toBe("FFDCFCE7");
    expect(fillOf(ws.getCell("E2"))).toBeUndefined();
    expect(ws.getColumn(2).width).toBe(42);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("writes a new result sheet and leaves the original sheet untouched", async () => {
    const bytes = await workbook({ Cases: [HEADERS, ["TC01", "Login", "Click Login", "Login page opens"], ["TC02", "OTP", "Enter OTP", "Logged in"]] });
    const out = await writeResults(bytes, { sheetName: "Cases", headerRow: 1, mode: "NEW_SHEET", results });
    expect(out.sheet).toBe("Cases Results");
    expect(await readBack(out.bytes, "Cases")).toEqual(await readBack(bytes, "Cases"));
    const copy = await readBack(out.bytes, "Cases Results");
    expect(copy[0]).toEqual([...HEADERS, "Actual Result", "Status", "Date"]);
    expect(copy[2].slice(0, 4)).toEqual(["TC02", "OTP", "Enter OTP", "Logged in"]);
    expect(copy[2][5]).toBe("HUMAN INTERACTION");
    const again = await writeResults(out.bytes, { sheetName: "Cases", headerRow: 1, mode: "NEW_SHEET", results });
    expect(again.sheet).toBe("Cases Results (2)");
  });
});

// ---------------------------------------------------------------- interpretation & evaluation

const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ url: "https://site.test/", title: "Home", headings: ["Welcome"], text: "Welcome to the site", invalidCount: 0, validationMessages: [], alerts: [], expandedCount: 0, cartCount: 0, prices: [], ...over });
const obs = (after: Partial<PageFacts>, extra: Partial<Observation> = {}): Observation => ({ before: facts(), after: facts(after), status: 200, downloads: 0, blockedWrites: 0, dialogs: [], elements: {}, ...extra });

describe("expected-result evaluation", () => {
  it("passes semantically equivalent outcomes, not just identical text", () => {
    const checks = planChecks("Login page should open.");
    expect(judge(checks, obs({ url: "https://site.test/login", headings: ["Sign in"] })).outcome).toBe("PASS");
    expect(judge(planChecks("Product should be added to cart."), obs({ cartCount: 1 })).outcome).toBe("PASS");
    expect(judge(planChecks("Products should be sorted from low to high price."), obs({ prices: [10, 20, 30] })).outcome).toBe("PASS");
  });

  it("fails with evidence when the expected behaviour did not happen", () => {
    const j = judge(planChecks("Login page should open."), obs({ url: "https://site.test/", headings: ["Welcome"] }));
    expect(j.outcome).toBe("FAIL");
    expect(j.details[0]).toMatch(/did not change/);
    expect(judge(planChecks("Products should be sorted from low to high price."), obs({ prices: [30, 10, 20] })).outcome).toBe("FAIL");
    expect(judge(planChecks('A "Thank you" message should be displayed.'), obs({ text: "Welcome" })).outcome).toBe("FAIL");
  });

  it("does not pass on similar words and leaves unmeasurable expectations to a person", () => {
    expect(judge(planChecks("The experience should feel delightful"), obs({})).outcome).toBe("UNDETERMINED");
    expect(judge(planChecks("Login page should open."), obs({ url: "https://site.test/log", headings: ["Logbook"] })).outcome).toBe("FAIL");
  });

  it("reports intercepted submissions instead of guessing", () => {
    expect(judge(planChecks("A success message is shown"), obs({}, { blockedWrites: 1 })).outcome).toBe("BLOCKED");
  });

  it("detects human interaction, device targeting and unsupported steps", () => {
    expect(detectHumanInteraction({ title: "Verify OTP login", steps: null, expected: "User logged in", preconditions: null })).toMatch(/one-time code/);
    expect(detectHumanInteraction({ title: "Checkout", steps: "Enter card number and pay", expected: "Order placed", preconditions: null })).toMatch(/payment/);
    expect(detectHumanInteraction({ title: "Open about page", steps: null, expected: "About page opens", preconditions: null })).toBeNull();
    expect(targetDevices({ title: "Menu on mobile", steps: null, expected: "Menu expands" })).toEqual(["mobile"]);
    const c = (steps: string | null, expected: string) => ({ rowNumber: 2, caseRef: "TC", title: "Case", steps, expected, url: null, testData: null, preconditions: null });
    expect(interpretCase(c("Upload a profile photo", "Photo shown"), "https://site.test/").notExecuted).toMatch(/upload/);
    expect(interpretCase(c("Do the magic dance", "Something happens"), "https://site.test/").notExecuted).toMatch(/could not be interpreted/);
    expect(interpretCase(c(null, "Products should be sorted from low to high price."), "https://site.test/")).toMatchObject({ inferred: true, actions: [{ kind: "select" }] });
    expect(interpretCase(c(null, "User should be redirected to the dashboard"), "https://site.test/")).toMatchObject({ inferred: true, actions: [{ kind: "click", text: "dashboard" }] });
  });

  it("aggregates browser/device results worst-first", () => {
    expect(aggregateStatus(["PASS", "NOT APPLICABLE"])).toBe("PASS");
    expect(aggregateStatus(["PASS", "FAIL"])).toBe("FAIL");
    expect(aggregateStatus(["PASS", "HUMAN INTERACTION"])).toBe("HUMAN INTERACTION");
    expect(aggregateStatus(["NOT APPLICABLE", "NOT APPLICABLE"])).toBe("NOT APPLICABLE");
  });
});

// ---------------------------------------------------------------- sources

describe("test-case sources", () => {
  it("parses Google Drive and Sheets share links", () => {
    expect(parseDriveLink("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=0")).toMatchObject({ isSpreadsheet: true, downloadUrl: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/export?format=xlsx" });
    expect(parseDriveLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing")).toMatchObject({ downloadUrl: "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp" });
    expect(parseDriveLink("https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOp")).toBeNull();
    expect(parseDriveLink("http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp")).toBeNull();
  });

  it("reports an inaccessible Drive file with a clear message and never crashes", async () => {
    const response = (over: Partial<HttpResult>): HttpResult => ({ ok: true, status: 200, finalUrl: "", chain: [], contentType: "text/html", contentLength: null, durationMs: 1, ...over });
    const loginPage = new GoogleDriveLinkSourceProvider(1_000_000, async () => response({ bytes: new TextEncoder().encode("<html>Sign in</html>") }));
    await expect(loginPage.load("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view")).rejects.toThrow(DRIVE_UNAVAILABLE);
    const denied = new GoogleDriveLinkSourceProvider(1_000_000, async () => response({ ok: false, status: 403 }));
    await expect(denied.load("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit")).rejects.toThrow(DRIVE_UNAVAILABLE);
    const offline = new GoogleDriveLinkSourceProvider(1_000_000, async () => response({ ok: false, status: null, error: { kind: "DNS", message: "x" } }));
    await expect(offline.load("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit")).rejects.toThrow(DRIVE_UNAVAILABLE);
    const bytes = await workbook({ S: [HEADERS] });
    const shared = new GoogleDriveLinkSourceProvider(1_000_000, async (_url, opts) => {
      expect(opts?.allowRedirect?.("", "https://accounts.google.com/signin")).toBe(false);
      expect(opts?.allowRedirect?.("", "https://doc-0s-8c-sheets.googleusercontent.com/export")).toBe(true);
      return response({ bytes });
    });
    await expect(shared.load("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit")).resolves.toMatchObject({ kind: "GOOGLE_DRIVE" });
  });

  it("reads local files only inside the configured folder", async () => {
    const dir = makeTempDir();
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${dir}/cases.xlsx`, await workbook({ S: [HEADERS] }));
    const local = new LocalPathSourceProvider(dir, 1_000_000);
    await expect(local.load("cases.xlsx")).resolves.toMatchObject({ kind: "LOCAL_PATH", sourceName: "cases.xlsx" });
    await expect(local.load("../outside.xlsx")).rejects.toThrow(SourceError);
    await expect(local.load("C:/Windows/win.ini")).rejects.toThrow(/inside the test-case folder|No file/);
    await expect(local.load("missing.xlsx")).rejects.toThrow(/No file/);
  });
});

// ---------------------------------------------------------------- service, history, bugs

describe("execution workflow", () => {
  let db: LocalDatabaseProvider;
  let deps: ExternalTestDeps;
  const okFetch = async (): Promise<HttpResult> => ({ ok: true, status: 200, finalUrl: "https://acme.test/", chain: [], contentType: "text/html", contentLength: null, durationMs: 1 });
  beforeEach(() => {
    db = createTestDb();
    deps = { db, storage: new LocalStorageProvider(makeTempDir()), maxUploadBytes: 5_000_000, localDir: makeTempDir(), fetcher: okFetch };
  });
  afterEach(async () => db.close());

  async function start(over: Partial<Parameters<typeof startExternalExecution>[1]> = {}) {
    const bytes = await workbook({ Cases: [HEADERS, ["TC01", "Login", "Click Login", "Login page should open"], ["TC02", "OTP", "Enter OTP", "Logged in"], ["TC03", "Cart", "Click Add to cart", "Product added to cart"]] });
    const inspected = await inspectSource(deps, { kind: "UPLOAD", fileName: "cases.xlsx", bytes });
    if (!inspected.ok) throw new Error(inspected.error);
    const d = inspected.value;
    return startExternalExecution(deps, { draftId: d.draftId, sourceKind: d.sourceKind, sourceName: d.sourceName, fileName: d.fileName, websiteUrl: "https://acme.test/", projectId: null, name: null, sheetName: d.sheet.name, mapping: d.sheet.mapping, browsers: ["chromium"], viewports: ["desktop-1440x900", "mobile-390x844", "tablet-768x1024"], outputMode: "EXISTING_SHEET", allowFormSubmission: false, ...over });
  }

  it("inspects an upload, lists sheets, maps columns and previews rows", async () => {
    const bytes = await workbook({ Intro: [["About this file"]], Cases: [HEADERS, ["TC01", "Login", "Click Login", "Login page should open"]] });
    const res = await inspectSource(deps, { kind: "UPLOAD", fileName: "cases.xlsx", bytes });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.sheets).toEqual(["Intro", "Cases"]);
    expect(res.value.sheet).toMatchObject({ name: "Cases", totalRows: 1, mapping: { caseId: 1, scenario: 2, steps: 3, expected: 4 }, existingSheetTarget: "Actual Result / Status / Date" });
    const other = await inspectDraftSheet(deps, res.value.draftId, "Intro");
    expect(other.ok).toBe(false);
    expect(await inspectDraftSheet(deps, "../../etc", "Cases")).toMatchObject({ ok: false });
    expect(await inspectSource(deps, { kind: "UPLOAD", fileName: "cases.xlsx", bytes: new Uint8Array([1, 2]) })).toMatchObject({ ok: false });
  });

  it("creates a run of type EXTERNAL_TEST_CASE with its cases, devices and project, and records history", async () => {
    const res = await start();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const run = await db.testRuns.getDetail(res.value.runId);
    expect(run).toMatchObject({ status: "PENDING", modules: ["external"], browsers: ["chromium"], viewports: ["desktop-1440x900", "mobile-390x844", "tablet-768x1024"] });
    expect(db.sqlite.prepare("SELECT run_type FROM test_runs WHERE id = ?").get(res.value.runId)).toEqual({ run_type: "EXTERNAL_TEST_CASE" });
    const exec = (await db.externalTests.get(res.value.runId))!;
    expect(exec).toMatchObject({ totalCases: 3, completedCases: 0, worksheet: "Cases", sourceKind: "UPLOAD", outputMode: "EXISTING_SHEET", projectName: "acme.test" });
    expect(await db.externalTests.count()).toBe(1);
    expect((await db.history.listRuns()).map((r) => r.id)).toContain(res.value.runId);
    // The same website reuses the project.
    const again = await start();
    expect(again.ok && (await db.externalTests.get(again.value.runId))!.projectId).toBe(exec.projectId);
  });

  it("rejects invalid input before anything is queued", async () => {
    expect(await start({ websiteUrl: "ftp://x" })).toMatchObject({ ok: false });
    expect(await start({ viewports: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/device/) });
    expect(await start({ mapping: { title: 2 } })).toMatchObject({ ok: false, error: expect.stringMatching(/Expected Result/) });
    deps.fetcher = async () => ({ ok: false, status: 404, finalUrl: "", chain: [], contentType: null, contentLength: null, durationMs: 1 });
    expect(await start()).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 404/) });
    expect(await db.externalTests.count()).toBe(0);
  });

  it("finalizes results across devices, writes the workbook and lets clear failures become bugs", async () => {
    const res = await start();
    if (!res.ok) throw new Error(res.error);
    const runId = res.value.runId;
    const store = new SqliteEngineStore(db.sqlite);
    const run = store.getRunForExecution(runId)!;
    expect(run.runType).toBe("EXTERNAL_TEST_CASE");
    const cases = store.getExternalCases(runId);
    store.markRunRunning(runId, 3);
    const page = run.pages[0];
    const rp = store.ensureRunPage(runId, page.id);
    const shot = `runs/${runId}/${page.id}/s.png`;
    const statuses = { TC01: ["PASS", "FAIL", "NOT APPLICABLE"], TC02: ["HUMAN INTERACTION", "HUMAN INTERACTION", "HUMAN INTERACTION"], TC03: ["PASS", "PASS", "PASS"] } as const;
    for (const c of cases) {
      for (const [i, viewport] of run.snapshot.viewports.entries()) {
        const status = statuses[c.caseRef as keyof typeof statuses][i];
        const s = externalSpec(c);
        const o = status === "PASS" ? outcome.pass(s, "ok", ["verified"]) : status === "FAIL" ? outcome.fail(s, "Login link missing on mobile", [{ type: "screenshot", label: "x", storageKey: shot }]) : status === "HUMAN INTERACTION" ? outcome.warn(s, "needs a person") : outcome.notApplicable(s, "n/a");
        store.recordOutcome({ runId, projectId: run.projectId, pageId: page.id, pageUrl: page.url, runPageId: rp, browser: "chromium", viewport, outcome: finalizeOutcome(o) });
        store.saveExternalObservation(runId, { caseId: c.id, browser: "chromium", viewport, status, actual: status === "HUMAN INTERACTION" ? "This test case needs human interaction." : `${status} on ${viewport}`, screenshotKey: status === "FAIL" ? shot : null, durationMs: 5 });
      }
    }
    const live = (await db.externalTests.get(runId))!;
    expect(live).toMatchObject({ completedCases: 3, counts: { PASS: 1, FAIL: 1, "HUMAN INTERACTION": 1 } });

    await finalizeExternalRun(db.sqlite, deps.storage, runId);
    store.finishRun(runId, "COMPLETED", null);
    const { rows } = await db.externalTests.listCases(runId);
    expect(rows.map((r) => [r.caseRef, r.status])).toEqual([["TC01", "FAIL"], ["TC02", "HUMAN INTERACTION"], ["TC03", "PASS"]]);
    expect(rows[0].actual).toMatch(/\[Mobile 390×844 · chromium\] FAIL/);
    expect(rows[0].observations.every((o) => o.testResultId)).toBe(true);

    const exec = (await db.externalTests.get(runId))!;
    expect(exec).toMatchObject({ outputError: null, resultColumns: { set: 1, actual: "Actual Result" } });
    expect(exec.outputFileName).toMatch(/^QA_External_Test_Result_acme\.test_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const file = (await db.externalTests.getOutputFile(runId))!;
    const out = await readBack((await deps.storage.get(file.storageKey))!, "Cases");
    expect(out[0].slice(4)).toEqual(["Actual Result", "Status", "Date"]);
    expect(out.slice(1).map((r) => r[5])).toEqual(["FAIL", "HUMAN INTERACTION", "PASS"]);
    expect(out[1][6]).toBe(new Date().toISOString().slice(0, 10));

    // The existing bug engine turns the verified failure into a bug referencing the external case.
    const summary = createBugsForRun(db.sqlite, runId);
    expect(summary.created).toBe(1);
    const [bug] = await db.bugs.list({ testRunId: runId });
    expect(bug).toMatchObject({ testType: "external", section: "External Test Case", viewport: "mobile-390x844" });
    expect(bug.title).toMatch(/^External Test Case: TC01: Login/);
    const detail = (await db.bugs.getDetail(bug.id))!;
    expect(detail.expectedResult).toBe("Login page should open");
    expect(detail.evidence.some((e) => e.storageKey === shot)).toBe(true);
  });

  it("deleting the project removes the execution, its cases and files", async () => {
    const res = await start();
    if (!res.ok) throw new Error(res.error);
    const exec = (await db.externalTests.get(res.value.runId))!;
    const { deleteProject } = await import("@/lib/services/projects");
    expect(await deleteProject({ db, storage: deps.storage, maxUploadBytes: 1 }, exec.projectId)).toBe(true);
    for (const t of ["external_test_executions", "external_test_cases", "external_test_observations"]) expect((db.sqlite.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c).toBe(0);
    expect(db.sqlite.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps website runs unaffected", async () => {
    const project = await db.projects.create(projectInput());
    const { page } = await db.pages.addManual(project.id, "https://example.com/", "https://example.com/");
    const run = await db.testRuns.createAndEnqueue({ projectId: project.id, configurationId: null, name: null, modules: ["seo"], browsers: ["chromium"], viewports: ["desktop-1440x900"], pageIds: [page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 } });
    expect(db.sqlite.prepare("SELECT run_type FROM test_runs WHERE id = ?").get(run.id)).toEqual({ run_type: "WEBSITE" });
    expect(await db.externalTests.get(run.id)).toBeNull();
  });
});
