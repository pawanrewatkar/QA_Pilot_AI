import fs from "node:fs";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import type { ExternalStatus } from "@/lib/external-tests/types";
import { inspectSource, startExternalExecution, type ExternalTestDeps } from "@/lib/services/external-tests";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { executeRun } from "@/worker/test-engine/run-executor";
import { startFixtureSite, type FixtureSite } from "../fixtures/site-server";
import { createTestDb, makeTempDir } from "../helpers";
import { browserInstalled, INTEGRATION_TIMEOUT } from "./helpers";

/** Sample external test-case workbook (acceptance test). Columns use customer-style headers. */
const CASES: [string, string, string, string, string][] = [
  // TC ID, Test Case, Page URL, Test Steps, Expected Result
  ["TC01", "Navigate to About", "", "1. Open homepage\n2. Click About", "User is redirected to the About page"],
  ["TC02", "Plan tabs", "", "Open homepage\nClick the Pro tab", '"Pro plan details" should be displayed'],
  ["TC03", "Search", "", 'Open the website\nSearch for "widget"', "Search results should be displayed"],
  ["TC04", "Contact form submission", "/contact", 'Enter "QA Tester" in the Name field\nEnter a valid email\nEnter "Hello" in the Message field\nClick Send message', "A thank you message is displayed"],
  ["TC05", "Contact form requires email", "/contact", 'Enter "QA" in the Name field\nLeave the Email field empty\nClick Send message', "An error message should be displayed for the email field"],
  ["TC06", "Login with OTP", "/login", "Enter the OTP received by SMS", "User is logged in"],
  ["TC07", "Privacy terms heading", "", "Open homepage\nClick Privacy", '"Terms and Conditions" should be displayed'],
  ["TC08", "Verify product sorting", "/catalog", "", "Products should be sorted from low to high price."],
  ["TC09", "Login link", "", "Click Login", "Login screen should open."],
  ["TC10", "Add widget to cart", "/products/widget", 'Select "Medium" from Size\nClick "Add to cart"', "Product should be added to cart."],
  ["TC11", "Pay for order", "/checkout", "Enter card number\nClick Pay now", "Order is placed and payment confirmed"],
  ["TC12", "Careers page", "", "Click Careers", "Careers page opens"],
  ["TC13", "Menu on tablet", "", "Open homepage on tablet\nTap the Open menu button", "Navigation menu expands"],
];

const EXPECTED: Record<string, ExternalStatus> = {
  TC01: "PASS",
  TC02: "PASS",
  TC03: "PASS",
  TC04: "NOT EXECUTED", // real submissions are disabled: the request is intercepted, never sent
  TC05: "PASS",
  TC06: "HUMAN INTERACTION",
  TC07: "FAIL",
  TC08: "PASS", // no steps: sorting steps are inferred
  TC09: "PASS",
  TC10: "PASS",
  TC11: "HUMAN INTERACTION",
  TC12: "NOT EXECUTED",
  TC13: "PASS", // NOT APPLICABLE on desktop, PASS on tablet
};

async function sampleWorkbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Read me").addRow(["Sample external test cases for QA Pilot AI"]);
  const ws = wb.addWorksheet("Test Cases");
  ws.addRow(["TC ID", "Test Case", "Page URL", "Test Steps", "Expected Result"]).font = { bold: true };
  for (const c of CASES) ws.addRow(c);
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.getColumn(4).width = 50;
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe.skipIf(!browserInstalled("chromium"))("External Test Case Testing against the local fixture (Chromium)", () => {
  let site: FixtureSite;
  let db: LocalDatabaseProvider;
  let deps: ExternalTestDeps;
  let root: string;
  let runId = "";

  async function execute(bytes: Uint8Array, viewports: string[], mode: "EXISTING_SHEET" | "NEW_SHEET") {
    const inspected = await inspectSource(deps, { kind: "UPLOAD", fileName: "acceptance.xlsx", bytes });
    if (!inspected.ok) throw new Error(inspected.error);
    const d = inspected.value;
    expect(d.sheet.name).toBe("Test Cases");
    const started = await startExternalExecution(deps, {
      draftId: d.draftId, sourceKind: d.sourceKind, sourceName: d.sourceName, fileName: d.fileName, websiteUrl: `${site.origin}/`, projectId: null, name: "Acceptance",
      sheetName: d.sheet.name, mapping: d.sheet.mapping, browsers: ["chromium"], viewports, outputMode: mode, allowFormSubmission: false,
    });
    if (!started.ok) throw new Error(started.error);
    db.sqlite.prepare("UPDATE jobs SET status = 'COMPLETED' WHERE json_extract(payload, '$.testRunId') = ?").run(started.value.runId);
    const summary = await executeRun(started.value.runId, { store: new SqliteEngineStore(db.sqlite), storage: deps.storage, log: () => undefined });
    expect(summary.status).toBe("COMPLETED");
    return started.value.runId;
  }

  beforeAll(async () => {
    site = await startFixtureSite();
    db = createTestDb();
    root = makeTempDir();
    deps = { db, storage: new LocalStorageProvider(root), maxUploadBytes: 10_000_000, localDir: makeTempDir() };
    runId = await execute(await sampleWorkbook(), ["desktop-1440x900", "tablet-768x1024"], "EXISTING_SHEET");
  }, INTEGRATION_TIMEOUT * 2);

  afterAll(async () => {
    await site?.close();
    await db?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("executes every case and decides each status from observed behaviour", async () => {
    const { rows } = await db.externalTests.listCases(runId, { limit: 100 });
    const got = Object.fromEntries(rows.map((r) => [r.caseRef, r.status]));
    expect(got, JSON.stringify(rows.map((r) => [r.caseRef, r.status, r.actual]), null, 1)).toEqual(EXPECTED);
    const by = (ref: string) => rows.find((r) => r.caseRef === ref)!;
    expect(by("TC01").actual).toMatch(/\/about/);
    expect(by("TC06").actual).toMatch(/^\[|This test case needs human interaction\./);
    expect(by("TC07").actual).toMatch(/Terms and Conditions.*not found/);
    expect(by("TC08").actual).toMatch(/inferred/);
    expect(by("TC12").actual).toMatch(/Careers/);
    const tablet = by("TC13").observations.map((o) => [o.viewport, o.status]);
    expect(tablet).toEqual(expect.arrayContaining([["desktop-1440x900", "NOT APPLICABLE"], ["tablet-768x1024", "PASS"]]));
    expect(site.writes.filter((w) => w.url === "/contact" || w.url.startsWith("/checkout"))).toEqual([]);
  });

  it("collects screenshot evidence, records history and creates bugs only for clear failures", async () => {
    const { rows } = await db.externalTests.listCases(runId, { limit: 100 });
    const shots = rows.flatMap((r) => r.observations.map((o) => o.screenshotKey)).filter((k): k is string => !!k);
    expect(shots.length).toBeGreaterThan(5);
    expect(await deps.storage.exists(shots[0])).toBe(true);
    const exec = (await db.externalTests.get(runId))!;
    expect(exec).toMatchObject({ runStatus: "COMPLETED", totalCases: 13, completedCases: 13 });
    expect(exec.counts).toEqual({ PASS: 8, FAIL: 1, "HUMAN INTERACTION": 2, "NOT EXECUTED": 2, "NOT APPLICABLE": 0 });
    expect((await db.history.listRuns()).find((r) => r.id === runId)).toBeTruthy();
    const bugs = await db.bugs.list({ testRunId: runId });
    expect(bugs.map((b) => b.testType)).toEqual(["external"]);
    expect(bugs[0].title).toMatch(/TC07/);
  });

  it("writes the results workbook with yellow human-interaction cells and versioned columns on re-run", async () => {
    const file = (await db.externalTests.getOutputFile(runId))!;
    expect(file.fileName).toMatch(/^QA_External_Test_Result_127\.0\.0\.1_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const first = (await deps.storage.get(file.storageKey))!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(first) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Test Cases")!;
    expect([6, 7, 8].map((c) => ws.getRow(1).getCell(c).value)).toEqual(["Actual Result", "Status", "Date"]);
    const tc06 = ws.getRow(7);
    expect(tc06.getCell(7).value).toBe("HUMAN INTERACTION");
    expect((tc06.getCell(6).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFF59D");
    expect(ws.getColumn(4).width).toBe(50);
    expect(wb.getWorksheet("Read me")).toBeTruthy();

    // A second execution on the returned workbook adds "Actual Result 2 / Status 2 / Date 2" and keeps the first results.
    const second = await execute(first, ["desktop-1440x900"], "EXISTING_SHEET");
    const out = (await deps.storage.get((await db.externalTests.getOutputFile(second))!.storageKey))!;
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(Buffer.from(out) as unknown as ArrayBuffer);
    const ws2 = wb2.getWorksheet("Test Cases")!;
    expect([6, 7, 8, 9, 10, 11].map((c) => ws2.getRow(1).getCell(c).value)).toEqual(["Actual Result", "Status", "Date", "Actual Result 2", "Status 2", "Date 2"]);
    for (let r = 2; r <= CASES.length + 1; r++) {
      expect(ws2.getRow(r).getCell(7).value).toBe(ws.getRow(r).getCell(7).value);
      expect(ws2.getRow(r).getCell(6).value).toBe(ws.getRow(r).getCell(6).value);
    }
    expect(ws2.getRow(8).getCell(10).value).toBe("FAIL");
  }, INTEGRATION_TIMEOUT);
});
