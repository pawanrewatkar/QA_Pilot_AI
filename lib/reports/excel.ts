import ExcelJS from "exceljs";
import type { ReportData, ReportResult } from "./data";
import { deviceOf } from "./data";

/**
 * Excel testing report and bug report. Every row is a recorded result; empty sections get a single
 * "No data recorded" row instead of invented values.
 */

const HEADER_FILL = "FF1F2937";
const STATUS_FILL: Record<string, string> = {
  PASS: "FFDCFCE7",
  FAIL: "FFFEE2E2",
  WARNING: "FFFEF3C7",
  "NOT EXECUTED": "FFF3F4F6",
  "NOT APPLICABLE": "FFF3F4F6",
  CRITICAL: "FFFECACA",
  HIGH: "FFFED7AA",
  MEDIUM: "FFFEF3C7",
  LOW: "FFE0F2FE",
  OPEN: "FFFEE2E2",
  REOPENED: "FFFED7AA",
  IN_PROGRESS: "FFE0F2FE",
  RESOLVED: "FFDCFCE7",
  CLOSED: "FFF3F4F6",
};

interface Column {
  header: string;
  key: string;
  width: number;
  /** Cells in this column get a status colour. */
  status?: boolean;
}

type Cell = string | number | null | undefined;

function addTable(wb: ExcelJS.Workbook, name: string, columns: Column[], rows: Record<string, Cell>[], note?: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 22;
  if (rows.length === 0) {
    ws.addRow({ [columns[0].key]: note ?? "No data recorded for this run." });
    return ws;
  }
  for (const r of rows) {
    const row = ws.addRow(Object.fromEntries(columns.map((c) => [c.key, r[c.key] === undefined || r[c.key] === null ? "" : truncateCell(r[c.key]!)])));
    row.alignment = { vertical: "top", wrapText: true };
    columns.forEach((c, i) => {
      if (!c.status) return;
      const fill = STATUS_FILL[String(r[c.key] ?? "")];
      if (fill) row.getCell(i + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  if (note) {
    ws.addRow({});
    ws.addRow({ [columns[0].key]: note }).font = { italic: true, color: { argb: "FF6B7280" } };
  }
  return ws;
}

/** Excel cells hold at most 32,767 characters. */
const truncateCell = (v: string | number) => (typeof v === "string" && v.length > 32000 ? `${v.slice(0, 32000)}… [truncated]` : v);

const viewportLabel = (v: string | null) => (v ? v.replace(/^(desktop|mobile)-/, (_, k: string) => `${k[0].toUpperCase()}${k.slice(1)} `) : "");

function resultRow(r: ReportResult): Record<string, Cell> {
  return {
    code: r.code,
    page: r.pageUrl,
    module: r.moduleLabel,
    scenario: r.scenarioType,
    section: r.section,
    feature: r.feature,
    element: r.element,
    title: r.title,
    browser: r.browser,
    viewport: viewportLabel(r.viewport),
    status: r.status,
    expected: r.expected,
    actual: r.actual,
    message: r.message,
    steps: r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    testData: r.testData,
    verifications: r.verifications.join("\n"),
    source: r.expectationSource.replace(/_/g, " ").toLowerCase(),
    executedAt: r.executedAt,
    screenshots: r.screenshotKeys.join("\n"),
  };
}

const RESULT_COLUMNS: Column[] = [
  { header: "Test Case ID", key: "code", width: 14 },
  { header: "Page URL", key: "page", width: 40 },
  { header: "Test Type", key: "module", width: 18 },
  { header: "Scenario", key: "scenario", width: 12 },
  { header: "Section", key: "section", width: 14 },
  { header: "Feature", key: "feature", width: 16 },
  { header: "Element", key: "element", width: 24 },
  { header: "Test Case", key: "title", width: 40 },
  { header: "Browser", key: "browser", width: 11 },
  { header: "Viewport", key: "viewport", width: 16 },
  { header: "Status", key: "status", width: 15, status: true },
  { header: "Expected Result", key: "expected", width: 40 },
  { header: "Actual Result", key: "actual", width: 40 },
  { header: "Message", key: "message", width: 30 },
  { header: "Steps", key: "steps", width: 40 },
  { header: "Test Data", key: "testData", width: 20 },
  { header: "Verifications", key: "verifications", width: 40 },
  { header: "Expectation Source", key: "source", width: 18 },
  { header: "Executed At", key: "executedAt", width: 22 },
  { header: "Screenshot Reference", key: "screenshots", width: 40 },
];

function detailSheet(wb: ExcelJS.Workbook, name: string, data: ReportData, viewId: string, extra: Column[] = []) {
  const view = data.details[viewId];
  const columns: Column[] = [
    { header: "Page URL", key: "page_url", width: 40 },
    { header: "Browser", key: "browser_name", width: 11 },
    { header: "Viewport", key: "viewport_id", width: 16 },
    ...extra,
    ...view.columns.map((c) => ({ header: c.label, key: c.key, width: c.format === "longtext" || c.format === "json" ? 50 : c.format === "mono" ? 30 : 16, status: c.format === "status" })),
  ];
  const note = view.truncated ? `Showing the first ${view.rows.length} of ${view.total} rows.` : undefined;
  addTable(wb, name, columns, view.rows as Record<string, Cell>[], note);
}

const by = (data: ReportData, modules: string[]) => data.results.filter((r) => modules.includes(r.module));

function workbook(data: ReportData, title: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = data.appName;
  wb.title = title;
  wb.company = data.appName;
  wb.created = new Date(data.generatedAt);
  return wb;
}

function summarySheet(wb: ExcelJS.Workbook, data: ReportData, rows: [string, Cell][]) {
  const ws = wb.addWorksheet("Summary");
  ws.columns = [{ width: 32 }, { width: 70 }];
  ws.addRow([data.appName]).font = { bold: true, size: 16 };
  ws.addRow([rows[0][0] === "Report" ? String(rows[0][1]) : ""]).font = { size: 12, color: { argb: "FF4B5563" } };
  ws.addRow([]);
  for (const [k, v] of rows.slice(1)) {
    const row = ws.addRow([k, v ?? ""]);
    row.getCell(1).font = { bold: true };
    row.alignment = { vertical: "top", wrapText: true };
    const fill = STATUS_FILL[k];
    if (fill) row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  }
  ws.addRow([]);
  ws.addRow([data.copyright]).font = { italic: true, color: { argb: "FF6B7280" } };
  return ws;
}

export async function buildTestingExcel(data: ReportData): Promise<Uint8Array> {
  const wb = workbook(data, "QA Testing Report");
  const c = data.counts;
  const executed = c.PASS + c.FAIL + c.WARNING;
  summarySheet(wb, data, [
    ["Report", "QA Testing Report"],
    ["Project", data.project.name],
    ["Website", data.project.websiteUrl],
    ["Test run", data.run.name ?? data.run.id],
    ["Run status", data.run.status],
    ["Started", data.run.startedAt],
    ["Completed", data.run.completedAt],
    ["Browsers", data.run.browsers.join(", ")],
    ["Viewports", data.run.viewports.join(", ")],
    ["Test types", data.run.modules.map((m) => m.label).join(", ")],
    ["Pages tested", data.pages.length],
    ["Total test results", data.totalResults],
    ["PASS", c.PASS],
    ["FAIL", c.FAIL],
    ["WARNING", c.WARNING],
    ["NOT EXECUTED", c["NOT EXECUTED"]],
    ["NOT APPLICABLE", c["NOT APPLICABLE"]],
    ["Pass rate (of executed checks)", executed ? `${Math.round((c.PASS / executed) * 1000) / 10}%` : "No executed checks"],
    ["Bugs observed in this run", data.bugs.length],
    ["Generated", data.generatedAt],
  ]);

  addTable(
    wb,
    "Page Wise Testing",
    [
      { header: "Page URL", key: "url", width: 50 },
      { header: "Page Name", key: "name", width: 24 },
      { header: "Page Type", key: "type", width: 14 },
      { header: "Page Run Status", key: "status", width: 16 },
      { header: "PASS", key: "pass", width: 9 },
      { header: "FAIL", key: "fail", width: 9 },
      { header: "WARNING", key: "warn", width: 11 },
      { header: "NOT EXECUTED", key: "ne", width: 14 },
      { header: "NOT APPLICABLE", key: "na", width: 16 },
      { header: "Bugs", key: "bugs", width: 9 },
    ],
    data.pages.map((p) => ({ url: p.url, name: p.name, type: p.pageType, status: p.status, pass: p.counts.PASS, fail: p.counts.FAIL, warn: p.counts.WARNING, ne: p.counts["NOT EXECUTED"], na: p.counts["NOT APPLICABLE"], bugs: p.bugs })),
  );

  addTable(wb, "UI Testing", RESULT_COLUMNS, by(data, ["ui", "responsive"]).map(resultRow));
  detailSheet(wb, "UI Measurements", data, "ui");
  addTable(
    wb,
    "Functional Testing",
    RESULT_COLUMNS,
    data.results
      .filter((r) => !["ui", "responsive", "links", "social-links", "performance", "accessibility", "seo", "console", "network", "content", "figma", "typography"].includes(r.module))
      .map(resultRow),
  );
  addTable(wb, "Positive Negative Edge Testing", RESULT_COLUMNS, data.results.filter((r) => r.scenarioType && r.scenarioType !== "FUNCTIONAL").map(resultRow));

  const linkResults = by(data, ["links", "social-links"]);
  addTable(wb, "Links", RESULT_COLUMNS, linkResults.map(resultRow));
  if (data.links.length) {
    addTable(
      wb,
      "Link Checks",
      [
        { header: "Page URL", key: "page_url", width: 40 },
        { header: "Link", key: "href", width: 45 },
        { header: "Resolved URL", key: "resolved_url", width: 45 },
        { header: "Text", key: "link_text", width: 24 },
        { header: "External", key: "is_external", width: 10 },
        { header: "HTTP Status", key: "http_status", width: 12 },
        { header: "Error", key: "error", width: 30 },
        { header: "Status", key: "status", width: 15, status: true },
      ],
      data.links.map((l) => ({ ...l, is_external: l.is_external ? "Yes" : "No" })),
    );
  }

  detailSheet(wb, "Performance", data, "performance");
  detailSheet(wb, "Accessibility", data, "accessibility");
  detailSheet(wb, "SEO", data, "seo");

  const consoleRows = data.details.console.rows.map((r) => ({ ...r, kind: "Console" }));
  const networkRows = data.details.network.rows.map((r) => ({ ...r, kind: "Network", message: `${r.method ?? ""} ${r.url ?? ""}`.trim() }));
  addTable(
    wb,
    "Console & Network",
    [
      { header: "Type", key: "kind", width: 10 },
      { header: "Page URL", key: "page_url", width: 40 },
      { header: "Browser", key: "browser_name", width: 11 },
      { header: "Viewport", key: "viewport_id", width: 16 },
      { header: "Level / Category", key: "level", width: 16 },
      { header: "Message / Request", key: "message", width: 60 },
      { header: "Source", key: "source_url", width: 35 },
      { header: "HTTP Status", key: "status_code", width: 12 },
      { header: "Resource Type", key: "resource_type", width: 14 },
      { header: "Error", key: "failure_text", width: 30 },
    ],
    [...consoleRows, ...networkRows.map((r) => ({ ...r, level: (r as Record<string, Cell>).error_category }))] as Record<string, Cell>[],
  );

  detailSheet(wb, "Content Comparison", data, "content");
  addTable(
    wb,
    "Figma Comparison",
    RESULT_COLUMNS,
    by(data, ["figma"]).map(resultRow),
    "Figma comparison runs only when a Figma provider is configured; until then results are NOT EXECUTED with the reason shown.",
  );
  detailSheet(wb, "Typography", data, "typography");

  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export async function buildBugExcel(data: ReportData): Promise<Uint8Array> {
  const wb = workbook(data, "QA Bug Report");
  addTable(
    wb,
    "Bug Report",
    [
      { header: "Bug ID", key: "code", width: 11 },
      { header: "Title", key: "title", width: 45 },
      { header: "Page Name", key: "pageName", width: 20 },
      { header: "Page URL", key: "pageUrl", width: 40 },
      { header: "Section", key: "section", width: 14 },
      { header: "Test Type", key: "testType", width: 18 },
      { header: "Scenario Type", key: "scenarioType", width: 13 },
      { header: "Device", key: "device", width: 20 },
      { header: "Browser", key: "browser", width: 11 },
      { header: "Severity", key: "severity", width: 11, status: true },
      { header: "Priority", key: "priority", width: 9 },
      { header: "Status", key: "status", width: 13, status: true },
      { header: "Expected Result", key: "expected", width: 40 },
      { header: "Actual Result", key: "actual", width: 40 },
      { header: "Steps To Reproduce", key: "steps", width: 45 },
      { header: "Element", key: "element", width: 24 },
      { header: "Selector", key: "selector", width: 30 },
      { header: "Technical Details", key: "technicalDetails", width: 60 },
      { header: "Screenshot Reference", key: "screenshotKey", width: 40 },
      { header: "Occurrences", key: "occurrences", width: 12 },
      { header: "Created Date", key: "createdAt", width: 22 },
    ],
    data.bugs as unknown as Record<string, Cell>[],
    data.bugs.length === 0 ? "No bugs were recorded for this run. Bugs are created only from verified failures." : undefined,
  );

  const count = (key: (b: ReportData["bugs"][number]) => string | null) => {
    const m = new Map<string, number>();
    for (const b of data.bugs) {
      const k = key(b) ?? "Unspecified";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const ws = summarySheet(wb, data, [
    ["Report", "QA Bug Report"],
    ["Project", data.project.name],
    ["Website", data.project.websiteUrl],
    ["Test run", data.run.name ?? data.run.id],
    ["Run completed", data.run.completedAt],
    ["Bugs observed in this run", data.bugs.length],
    ["CRITICAL", data.bugs.filter((b) => b.severity === "CRITICAL").length],
    ["HIGH", data.bugs.filter((b) => b.severity === "HIGH").length],
    ["MEDIUM", data.bugs.filter((b) => b.severity === "MEDIUM").length],
    ["LOW", data.bugs.filter((b) => b.severity === "LOW").length],
    ...count((b) => b.priority).map(([k, v]): [string, Cell] => [`Priority ${k}`, v]),
    ...count((b) => b.status).map(([k, v]): [string, Cell] => [`Status ${k.replace(/_/g, " ")}`, v]),
    ...count((b) => (b.device ? b.device.split(" ")[0] : deviceOf(null))).map(([k, v]): [string, Cell] => [`Device ${k}`, v]),
    ["Generated", data.generatedAt],
  ]);
  ws.name = "Bug Summary";

  const byType = new Map<string, Record<string, number>>();
  for (const b of data.bugs) {
    const t = b.testType ?? "Unspecified";
    const row = byType.get(t) ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, total: 0 };
    row[b.severity]++;
    row.total++;
    byType.set(t, row);
  }
  addTable(
    wb,
    "Testing Type Bug Count",
    [
      { header: "Testing Type", key: "type", width: 26 },
      { header: "Total Bugs", key: "total", width: 12 },
      { header: "Critical", key: "CRITICAL", width: 10 },
      { header: "High", key: "HIGH", width: 10 },
      { header: "Medium", key: "MEDIUM", width: 10 },
      { header: "Low", key: "LOW", width: 10 },
    ],
    [...byType.entries()].sort((a, b) => b[1].total - a[1].total).map(([type, r]) => ({ type, ...r })),
  );

  return new Uint8Array(await wb.xlsx.writeBuffer());
}
