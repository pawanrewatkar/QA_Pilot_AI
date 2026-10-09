import { APP_NAME, COPYRIGHT_NOTICE } from "@/lib/constants/brand";
import { DETAIL_VIEWS } from "@/lib/constants/detail-views";
import { getTestModule } from "@/lib/constants/testing";
import { LocalBugRepository } from "@/lib/database/local/bug-repository";
import { LocalTestResultRepository, runDetail } from "@/lib/database/local/engine-repositories";
import type { DetailRowRecord } from "@/lib/database/provider";
import type { SqliteDatabase } from "@/lib/database/local/sqlite-client";
import type { BugDetail, ResultStatusCounts, TestResultRecord, TestResultStatus } from "@/types";
import { redactRecord, redactText } from "./redact";

/**
 * Everything a report needs, read from the database for one test run. Only recorded results are
 * included; sections without data stay empty and are rendered as "no data", never filled in.
 * All free text passes through redactText so secrets and personal data do not reach a report.
 */
export interface ReportData {
  appName: string;
  copyright: string;
  generatedAt: string;
  project: { id: string; name: string; websiteUrl: string };
  run: {
    id: string;
    name: string | null;
    status: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    modules: { id: string; label: string }[];
    browsers: string[];
    viewports: string[];
    options: { label: string; value: string }[];
    errorMessage: string | null;
  };
  counts: ResultStatusCounts;
  totalResults: number;
  pages: ReportPage[];
  results: ReportResult[];
  bugs: ReportBug[];
  details: Record<string, { label: string; columns: { key: string; label: string; format?: string }[]; rows: DetailRowRecord[]; total: number; truncated: boolean }>;
  links: Record<string, string | number | null>[];
  screenshots: ReportScreenshot[];
}

export interface ReportPage {
  id: string;
  url: string;
  name: string | null;
  pageType: string | null;
  status: string;
  counts: ResultStatusCounts;
  bugs: number;
}

export interface ReportResult {
  id: string;
  code: string | null;
  module: string;
  moduleLabel: string;
  scenarioType: string | null;
  section: string | null;
  feature: string | null;
  element: string | null;
  title: string;
  pageUrl: string | null;
  browser: string | null;
  viewport: string | null;
  status: TestResultStatus;
  expected: string | null;
  actual: string | null;
  message: string | null;
  steps: string[];
  testData: string | null;
  verifications: string[];
  expectationSource: string;
  executedAt: string | null;
  durationMs: number | null;
  screenshotKeys: string[];
}

export interface ReportBug {
  id: string;
  code: string | null;
  title: string;
  pageName: string | null;
  pageUrl: string | null;
  section: string | null;
  testType: string | null;
  scenarioType: string | null;
  device: string | null;
  browser: string | null;
  severity: string;
  priority: string;
  status: string;
  expected: string | null;
  actual: string | null;
  steps: string | null;
  element: string | null;
  selector: string | null;
  technicalDetails: string | null;
  screenshotKey: string | null;
  createdAt: string;
  occurrences: number;
}

export interface ReportScreenshot {
  key: string;
  label: string | null;
  kind: string;
  pageUrl: string | null;
  browser: string | null;
  viewport: string | null;
  capturedAt: string;
  /** Result/bug this screenshot is evidence for, when known. */
  context: string | null;
}

/** Maximum number of rows per detail table; the report states when a table was cut. */
export const DETAIL_ROW_CAP = 5000;
/** Screenshots embedded in HTML/PDF reports (failures first). Excel reports reference keys only. */
export const SCREENSHOT_CAP = 60;

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const emptyCounts = (): ResultStatusCounts => ({ PASS: 0, FAIL: 0, WARNING: 0, "NOT EXECUTED": 0, "NOT APPLICABLE": 0 });
export const moduleLabel = (id: string) => (id === "page-load" ? "Page Load" : getTestModule(id)?.label ?? id);
const redactOrNull = (s: string | null) => (s === null ? null : redactText(s));

export const deviceOf = (viewport: string | null) => (viewport ? (viewport.startsWith("mobile") ? "Mobile" : viewport.startsWith("tablet") ? "Tablet" : viewport.startsWith("desktop") ? "Desktop" : viewport) : null);

export async function loadReportData(db: SqliteDatabase, runId: string): Promise<ReportData> {
  const detail = runDetail(db, runId);
  if (!detail) throw new Error(`Test run ${runId} not found`);
  const project = db.prepare("SELECT id, name, website_url FROM projects WHERE id = ?").get(detail.projectId) as Row;

  const repo = new LocalTestResultRepository(db);
  const raw: TestResultRecord[] = [];
  for (let offset = 0; ; offset += 2000) {
    const batch = await repo.listByRun(runId, { limit: 2000, offset });
    raw.push(...batch);
    if (batch.length < 2000) break;
  }
  const results: ReportResult[] = raw.map((r) => ({
    id: r.id,
    code: r.caseCode,
    module: r.module,
    moduleLabel: moduleLabel(r.module),
    scenarioType: r.scenarioType,
    section: r.section,
    feature: r.feature,
    element: redactOrNull(r.element),
    title: redactText(r.title),
    pageUrl: redactOrNull(r.url),
    browser: r.browser,
    viewport: r.viewport,
    status: r.status,
    expected: redactOrNull(r.expectedResult),
    actual: redactOrNull(r.actualResult),
    message: redactOrNull(r.message),
    steps: r.steps.map(redactText),
    testData: redactOrNull(r.testData),
    verifications: r.verifications.map(redactText),
    expectationSource: r.expectationSource,
    executedAt: r.executedAt,
    durationMs: r.durationMs,
    screenshotKeys: r.evidence.filter((e) => e.type === "screenshot" && e.storageKey).map((e) => e.storageKey!),
  }));

  const counts = emptyCounts();
  for (const r of results) counts[r.status]++;

  // Bugs observed in this run (new or recurring), with the fields of the bug report.
  const bugRepo = new LocalBugRepository(db);
  const bugList = await bugRepo.list({ testRunId: runId, limit: 1000 });
  const bugs: ReportBug[] = [];
  const bugsByPage = new Map<string, number>();
  for (const b of bugList) {
    const d = (await bugRepo.getDetail(b.id)) as BugDetail;
    const occ = d.occurrences.find((o) => o.testRunId === runId);
    const viewport = occ?.viewport ?? d.viewport;
    bugs.push({
      id: d.id,
      code: d.code,
      title: redactText(d.title),
      pageName: d.pageName,
      pageUrl: redactOrNull(d.pageUrl),
      section: d.section,
      testType: d.testType ? moduleLabel(d.testType) : null,
      scenarioType: d.scenarioType,
      device: viewport ? `${deviceOf(viewport)} (${viewport.replace(/^(desktop|mobile|tablet)-/, "")})` : null,
      browser: occ?.browser ?? d.browser,
      severity: d.severity,
      priority: d.priority,
      status: d.status,
      expected: redactOrNull(d.expectedResult),
      actual: redactOrNull(occ?.actualResult ?? d.actualResult),
      steps: redactOrNull(d.stepsToReproduce),
      element: redactOrNull(d.element),
      selector: d.selector,
      technicalDetails: redactOrNull(d.technicalDetails),
      screenshotKey: d.screenshotKey,
      createdAt: d.createdAt,
      occurrences: d.occurrenceCount,
    });
    const pageId = (db.prepare("SELECT page_id FROM bugs WHERE id = ?").get(d.id) as Row | undefined)?.page_id;
    if (pageId) bugsByPage.set(String(pageId), (bugsByPage.get(String(pageId)) ?? 0) + 1);
  }

  const pageRows = db
    .prepare(
      `SELECT p.id, p.url, p.name, p.page_type, trp.status FROM test_run_pages trp JOIN pages p ON p.id = trp.page_id
       WHERE trp.test_run_id = ? ORDER BY p.url`,
    )
    .all(runId) as Row[];
  const pageCounts = new Map<string, ResultStatusCounts>();
  for (const r of raw) {
    if (!r.pageId) continue;
    const c = pageCounts.get(r.pageId) ?? emptyCounts();
    c[r.status]++;
    pageCounts.set(r.pageId, c);
  }
  const pages: ReportPage[] = pageRows.map((p) => ({
    id: String(p.id),
    url: redactText(String(p.url)),
    name: str(p.name),
    pageType: str(p.page_type),
    status: String(p.status),
    counts: pageCounts.get(String(p.id)) ?? emptyCounts(),
    bugs: bugsByPage.get(String(p.id)) ?? 0,
  }));

  const details: ReportData["details"] = {};
  for (const view of DETAIL_VIEWS) {
    const rows: DetailRowRecord[] = [];
    let total = 0;
    for (let offset = 0; offset < DETAIL_ROW_CAP; offset += 1000) {
      const page = await repo.listDetails(runId, view.id, { limit: 1000, offset });
      total = page.total;
      rows.push(...page.rows.map((r) => redactRecord(r)));
      if (page.rows.length < 1000) break;
    }
    details[view.id] = { label: view.label, columns: view.columns.map(({ key, label, format }) => ({ key, label, format })), rows, total, truncated: total > rows.length };
  }

  const links = (
    db
      .prepare(
        `SELECT pg.url AS page_url, l.href, l.resolved_url, l.link_text, l.is_external, l.http_status, l.error, tr.status, tr.browser, tr.viewport
         FROM link_results l LEFT JOIN pages pg ON pg.id = l.page_id LEFT JOIN test_results tr ON tr.id = l.test_result_id
         WHERE l.test_run_id = ? ORDER BY CASE tr.status WHEN 'FAIL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, pg.url, l.href LIMIT ?`,
      )
      .all(runId, DETAIL_ROW_CAP) as Row[]
  ).map((r) => redactRecord(r as Record<string, string | number | null>));

  // Screenshots: evidence of failures first, then warnings, then the rest; capped for embedding.
  const shotRows = db
    .prepare(
      `SELECT s.storage_key, s.label, s.kind, s.browser, s.viewport, s.captured_at, pg.url AS page_url FROM screenshots s
       LEFT JOIN pages pg ON pg.id = s.page_id WHERE s.test_run_id = ? ORDER BY s.captured_at`,
    )
    .all(runId) as Row[];
  const contextByKey = new Map<string, { rank: number; context: string }>();
  for (const r of results) {
    const rank = r.status === "FAIL" ? 0 : r.status === "WARNING" ? 1 : 2;
    for (const key of r.screenshotKeys) {
      const prev = contextByKey.get(key);
      if (!prev || rank < prev.rank) contextByKey.set(key, { rank, context: `${r.status}: ${r.code ?? ""} ${r.title}`.trim() });
    }
  }
  for (const b of bugs) if (b.screenshotKey) contextByKey.set(b.screenshotKey, { rank: -1, context: `${b.code ?? "Bug"}: ${b.title}` });
  const rankOf = (key: string) => contextByKey.get(key)?.rank ?? 3;
  const screenshots: ReportScreenshot[] = shotRows
    .map((s): ReportScreenshot => ({
      key: String(s.storage_key),
      label: str(s.label),
      kind: String(s.kind ?? "VIEWPORT"),
      pageUrl: redactOrNull(str(s.page_url)),
      browser: str(s.browser),
      viewport: str(s.viewport),
      capturedAt: String(s.captured_at),
      context: contextByKey.get(String(s.storage_key))?.context ?? null,
    }))
    .sort((a, b) => rankOf(a.key) - rankOf(b.key) || a.capturedAt.localeCompare(b.capturedAt))
    .slice(0, SCREENSHOT_CAP);

  const options = detail.options;
  const optionList: { label: string; value: string }[] = [
    { label: "Real form submissions", value: options.allowFormSubmission ? "Allowed" : "Not allowed" },
    { label: "Max links per page", value: String(options.maxLinksPerPage) },
    { label: "Navigation timeout", value: `${Math.round(options.navigationTimeoutMs / 1000)} s` },
  ];
  if (options.typographyMode) optionList.push({ label: "Typography mode", value: options.typographyMode.replace(/_/g, " ").toLowerCase() });
  if (options.content) optionList.push({ label: "Content comparison", value: `${options.content.mode.toLowerCase()} mode` });
  if (options.performance) optionList.push({ label: "Performance form factors", value: options.performance.formFactors.join(", ") });

  return {
    appName: APP_NAME,
    copyright: COPYRIGHT_NOTICE,
    generatedAt: new Date().toISOString(),
    project: { id: String(project.id), name: String(project.name), websiteUrl: redactText(String(project.website_url)) },
    run: {
      id: detail.id,
      name: detail.name,
      status: detail.status,
      createdAt: detail.createdAt,
      startedAt: detail.startedAt,
      completedAt: detail.completedAt,
      modules: detail.modules.map((id) => ({ id, label: moduleLabel(id) })),
      browsers: detail.browsers,
      viewports: detail.viewports,
      options: optionList,
      errorMessage: redactOrNull(detail.errorMessage),
    },
    counts,
    totalResults: results.length,
    pages,
    results,
    bugs,
    details,
    links,
    screenshots,
  };
}

/** Host name used in report file names, e.g. "example.com". */
export function websiteSlug(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep raw */
  }
  return host.replace(/^www\./, "").replace(/[^A-Za-z0-9.-]+/g, "_").slice(0, 60) || "website";
}

export function reportFileNames(websiteUrl: string, date: Date) {
  const d = date.toISOString().slice(0, 10);
  const site = websiteSlug(websiteUrl);
  return {
    testingExcel: `QA_Testing_Report_${site}_${d}.xlsx`,
    bugExcel: `QA_Bug_Report_${site}_${d}.xlsx`,
    pdf: `QA_Report_${site}_${d}.pdf`,
    html: `QA_Report_${site}_${d}.html`,
  };
}
