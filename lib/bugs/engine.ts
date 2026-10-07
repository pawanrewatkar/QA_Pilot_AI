import { randomUUID } from "node:crypto";
import { getTestModule } from "@/lib/constants/testing";
import type { SqliteDatabase } from "@/lib/database/local/sqlite-client";
import { redactText } from "@/lib/reports/redact";
import type { EvidenceItem, PageType } from "@/types";
import { bugFingerprint, classifySeverity, httpStatusFrom, priorityFor } from "./classify";
import { DeterministicDuplicateDetector, type DuplicateDetector } from "./duplicates";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === "string" ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

export interface BugEngineSummary {
  failures: number;
  created: number;
  updated: number;
  reopened: number;
  bugIds: string[];
}

interface FailureRow {
  resultId: string;
  runId: string;
  projectId: string;
  pageId: string | null;
  pageUrl: string;
  pageName: string | null;
  pageType: PageType | null;
  browser: string | null;
  viewport: string | null;
  actual: string;
  executedAt: string;
  evidence: EvidenceItem[];
  verifications: string[];
  caseId: string;
  caseKey: string;
  module: string;
  title: string;
  section: string | null;
  scenarioType: string | null;
  feature: string | null;
  element: string | null;
  steps: string[];
  expected: string | null;
}

export const moduleName = (id: string) => (id === "page-load" ? "Page load" : getTestModule(id)?.label.replace(/ Testing$/, "") ?? id);

function loadFailures(db: SqliteDatabase, runId: string): FailureRow[] {
  const rows = db
    .prepare(
      `SELECT tr.id AS result_id, tr.test_run_id, r.project_id, tr.page_id, COALESCE(pg.url, tr.url, tc.page_url) AS page_url, pg.name AS page_name,
         pg.page_type, tr.browser, tr.viewport, tr.actual_result, tr.executed_at, tr.evidence, tr.verifications,
         tc.id AS case_id, tc.case_key, tc.module, tc.title, tc.section, tc.scenario_type, tc.feature, tc.element, tc.steps, tc.expected_result
       FROM test_results tr
       JOIN test_cases tc ON tc.id = tr.test_case_id
       JOIN test_runs r ON r.id = tr.test_run_id
       LEFT JOIN pages pg ON pg.id = tr.page_id
       WHERE tr.test_run_id = ? AND tr.status = 'FAIL' AND tr.executed_at IS NOT NULL AND tc.case_key IS NOT NULL
       ORDER BY tr.created_at, tr.rowid`,
    )
    .all(runId) as Row[];
  return rows.map((r) => ({
    resultId: String(r.result_id),
    runId: String(r.test_run_id),
    projectId: String(r.project_id),
    pageId: str(r.page_id),
    pageUrl: String(r.page_url ?? ""),
    pageName: str(r.page_name),
    pageType: str(r.page_type) as PageType | null,
    browser: str(r.browser),
    viewport: str(r.viewport),
    actual: String(r.actual_result ?? ""),
    executedAt: String(r.executed_at),
    evidence: json<EvidenceItem[]>(r.evidence, []),
    verifications: json<string[]>(r.verifications, []),
    caseId: String(r.case_id),
    caseKey: String(r.case_key),
    module: String(r.module),
    title: String(r.title),
    section: str(r.section),
    scenarioType: str(r.scenario_type),
    feature: str(r.feature),
    element: str(r.element),
    steps: json<string[]>(r.steps, []),
    expected: str(r.expected_result),
  }));
}

/** First selector recorded for the result in the per-check tables (UI element, axe target). */
function selectorFor(db: SqliteDatabase, resultId: string): string | null {
  for (const sql of [
    "SELECT selector AS s FROM ui_results WHERE test_result_id = ? AND selector IS NOT NULL LIMIT 1",
    "SELECT target_selector AS s FROM accessibility_results WHERE test_result_id = ? AND target_selector IS NOT NULL LIMIT 1",
    "SELECT selector AS s FROM typography_results WHERE test_result_id = ? LIMIT 1",
  ]) {
    const row = db.prepare(sql).get(resultId) as Row | undefined;
    if (row?.s) return String(row.s);
  }
  return null;
}

function axeImpactFor(db: SqliteDatabase, resultId: string): string | null {
  const row = db
    .prepare(
      `SELECT impact FROM accessibility_results WHERE test_result_id = ? AND impact IS NOT NULL
       ORDER BY CASE impact WHEN 'critical' THEN 0 WHEN 'serious' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END LIMIT 1`,
    )
    .get(resultId) as Row | undefined;
  return str(row?.impact);
}

/** Console errors and failed requests recorded for the same page, run, browser and viewport. */
function observationsFor(db: SqliteDatabase, f: FailureRow) {
  if (!f.pageId) return { console: [] as Row[], network: [] as Row[] };
  const console = db
    .prepare("SELECT level, message, source_url, logged_at FROM console_results WHERE test_run_id = ? AND page_id = ? AND browser IS ? AND viewport IS ? AND level = 'error' LIMIT 20")
    .all(f.runId, f.pageId, f.browser, f.viewport) as Row[];
  const network = db
    .prepare("SELECT method, url, resource_type, status_code, failure_text, error_category FROM network_results WHERE test_run_id = ? AND page_id = ? AND browser IS ? AND viewport IS ? LIMIT 20")
    .all(f.runId, f.pageId, f.browser, f.viewport) as Row[];
  return { console, network };
}

function screenshotKind(db: SqliteDatabase, key: string): "VIEWPORT" | "FULL_PAGE" | "ELEMENT" {
  const row = db.prepare("SELECT kind FROM screenshots WHERE storage_key = ?").get(key) as Row | undefined;
  return (str(row?.kind) as "VIEWPORT" | "FULL_PAGE" | "ELEMENT" | null) ?? "VIEWPORT";
}

function nextBugCode(db: SqliteDatabase, projectId: string): string {
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) AS n FROM bugs WHERE project_id = ? AND code LIKE 'BUG-%'").get(projectId) as Row;
  return `BUG-${String(Number(row.n ?? 0) + 1).padStart(4, "0")}`;
}

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function buildTechnicalDetails(f: FailureRow, obs: ReturnType<typeof observationsFor>): string {
  const parts: string[] = [];
  if (f.verifications.length) parts.push(`Observations:\n- ${f.verifications.join("\n- ")}`);
  for (const e of f.evidence) if (e.type !== "screenshot" && e.content) parts.push(`${e.label}:\n${e.content}`);
  if (obs.console.length) parts.push(`Console errors on this page (${f.browser}, ${f.viewport}):\n${obs.console.map((c) => `- ${c.message}`).join("\n")}`);
  if (obs.network.length) {
    parts.push(`Failed requests on this page (${f.browser}, ${f.viewport}):\n${obs.network.map((n) => `- ${n.method} ${n.url} → ${n.status_code ?? n.failure_text} (${n.resource_type})`).join("\n")}`);
  }
  return redactText(parts.join("\n\n")).slice(0, 12_000);
}

function insertEvidence(db: SqliteDatabase, bugId: string, f: FailureRow, obs: ReturnType<typeof observationsFor>, selector: string | null) {
  const exists = db.prepare("SELECT 1 FROM bug_evidence WHERE bug_id = ? AND test_result_id = ? LIMIT 1").get(bugId, f.resultId);
  if (exists) return;
  const ins = db.prepare(
    `INSERT INTO bug_evidence (id, bug_id, evidence_type, screenshot_id, storage_key, content, label, screenshot_kind, test_run_id, test_result_id, url, browser, viewport, selector, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const base = (type: string, label: string, storageKey: string | null, content: string | null, kind: string | null, screenshotId: string | null = null) =>
    ins.run(randomUUID(), bugId, type, screenshotId, storageKey, content, label, kind, f.runId, f.resultId, f.pageUrl, f.browser, f.viewport, selector, f.executedAt);
  const seenKeys = new Set<string>();
  for (const e of f.evidence) {
    if (e.type === "screenshot" && e.storageKey) {
      seenKeys.add(e.storageKey);
      const shot = db.prepare("SELECT id FROM screenshots WHERE storage_key = ?").get(e.storageKey) as Row | undefined;
      base("SCREENSHOT", e.label, e.storageKey, null, screenshotKind(db, e.storageKey), str(shot?.id));
    } else if (e.content) {
      const type = e.type === "console" ? "CONSOLE_LOG" : e.type === "network" || e.type === "http" ? "NETWORK_LOG" : e.type === "dom" ? "HTML_SNAPSHOT" : "OTHER";
      base(type, e.label, null, redactText(e.content), null);
    }
  }
  // Full-page screenshot taken for this page/browser/viewport after the failures were recorded.
  if (f.pageId) {
    const full = db
      .prepare("SELECT id, storage_key FROM screenshots WHERE test_run_id = ? AND page_id = ? AND browser IS ? AND viewport IS ? AND kind = 'FULL_PAGE' ORDER BY captured_at DESC LIMIT 1")
      .get(f.runId, f.pageId, f.browser, f.viewport) as Row | undefined;
    if (full && !seenKeys.has(String(full.storage_key))) base("SCREENSHOT", "Full page after testing", String(full.storage_key), null, "FULL_PAGE", String(full.id));
  }
  if (obs.console.length) base("CONSOLE_LOG", "Console errors", null, redactText(obs.console.map((c) => `[${c.logged_at}] ${c.message}${c.source_url ? ` (${c.source_url})` : ""}`).join("\n")).slice(0, 8000), null);
  if (obs.network.length) base("NETWORK_LOG", "Failed requests", null, redactText(obs.network.map((n) => `${n.method} ${n.url} → ${n.status_code ?? n.failure_text} [${n.error_category}]`).join("\n")).slice(0, 8000), null);
}

/**
 * Creates or updates bugs from the verified failures (status FAIL, executed, with evidence) of a
 * run. Never creates a bug from a WARNING, NOT EXECUTED or NOT APPLICABLE result. Idempotent:
 * re-running it for the same run adds nothing new. Never marks a bug as resolved.
 */
export function createBugsForRun(db: SqliteDatabase, runId: string, detector: DuplicateDetector = new DeterministicDuplicateDetector()): BugEngineSummary {
  const failures = loadFailures(db, runId).filter((f) => f.evidence.length > 0 && f.pageUrl);
  const summary: BugEngineSummary = { failures: failures.length, created: 0, updated: 0, reopened: 0, bugIds: [] };
  if (!failures.length) return summary;

  const groups = new Map<string, FailureRow[]>();
  for (const f of failures) {
    const fp = bugFingerprint(f.pageUrl, f.caseKey);
    groups.set(fp, [...(groups.get(fp) ?? []), f]);
  }

  const tx = db.transaction(() => {
    for (const [fingerprint, rows] of groups) {
      const first = rows[0];
      const projectBugs = (db.prepare("SELECT id, fingerprint, page_url, test_type, selector, element, status FROM bugs WHERE project_id = ?").all(first.projectId) as Row[]).map((b) => ({
        id: String(b.id),
        fingerprint: String(b.fingerprint ?? ""),
        pageUrl: str(b.page_url),
        testType: str(b.test_type),
        selector: str(b.selector),
        element: str(b.element),
        status: String(b.status),
      }));
      const selector = selectorFor(db, first.resultId);
      const duplicate = detector.find({ fingerprint, pageUrl: first.pageUrl, testType: first.module, selector, element: first.element }, projectBugs).find((m) => m.kind === "duplicate");
      const ts = now();
      let bugId: string;

      if (duplicate) {
        bugId = duplicate.bugId;
        const existing = projectBugs.find((b) => b.id === bugId)!;
        const newlySeen = rows.filter((r) => !db.prepare("SELECT 1 FROM bug_occurrences WHERE bug_id = ? AND test_result_id = ?").get(bugId, r.resultId));
        if (!newlySeen.length) continue;
        summary.updated++;
        if (existing.status === "RESOLVED" || existing.status === "CLOSED") {
          db.prepare("UPDATE bugs SET status = 'REOPENED', updated_at = ? WHERE id = ?").run(ts, bugId);
          db.prepare("INSERT INTO bug_status_history (id, bug_id, from_status, to_status, note, source, changed_at) VALUES (?, ?, ?, 'REOPENED', ?, 'ENGINE', ?)").run(
            randomUUID(), bugId, existing.status, `The same failure was observed again in run ${runId} with new evidence.`, ts,
          );
          summary.reopened++;
        }
      } else {
        const actual = redactText(first.actual);
        const evidenceText = [first.actual, ...first.evidence.map((e) => e.content ?? "")].join("\n");
        const sev = classifySeverity({
          module: first.module, caseKey: first.caseKey, title: first.title, section: first.section, actual, viewport: first.viewport, pageType: first.pageType,
          axeImpact: axeImpactFor(db, first.resultId), httpStatus: httpStatusFrom(evidenceText),
        });
        const prio = priorityFor(sev.severity, first.pageType);
        const shot = first.evidence.find((e) => e.type === "screenshot" && e.storageKey)?.storageKey ?? null;
        const steps = [`Open ${first.pageUrl} in ${first.browser ?? "the browser"} at ${first.viewport ?? "the tested viewport"}.`, ...first.steps];
        bugId = randomUUID();
        db.prepare(
          `INSERT INTO bugs (id, project_id, code, test_run_id, test_result_id, test_case_id, page_id, title, description, page_name, page_url, section, test_type,
             scenario_type, severity, severity_reason, priority, status, steps_to_reproduce, expected_result, actual_result, element, selector, technical_details,
             screenshot_key, browser, viewport, fingerprint, first_seen_run_id, last_seen_run_id, last_seen_at, occurrence_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        ).run(
          bugId, first.projectId, nextBugCode(db, first.projectId), runId, first.resultId, first.caseId, first.pageId,
          redactText(`${moduleName(first.module)}: ${first.title} (${pathOf(first.pageUrl)})`).slice(0, 300), actual, first.pageName, redactText(first.pageUrl),
          first.section, first.module, first.scenarioType, sev.severity, `${sev.reason} Priority: ${prio.reason}.`, prio.priority,
          steps.map((st, i) => `${i + 1}. ${st}`).join("\n"), first.expected, actual, redactText(first.element ?? ""), selector,
          buildTechnicalDetails(first, observationsFor(db, first)), shot, first.browser, first.viewport, fingerprint, runId, runId, first.executedAt, ts, ts,
        );
        db.prepare("INSERT INTO bug_status_history (id, bug_id, from_status, to_status, note, source, changed_at) VALUES (?, ?, NULL, 'OPEN', ?, 'ENGINE', ?)").run(
          randomUUID(), bugId, `Created from a verified failure in run ${runId}.`, ts,
        );
        summary.created++;
      }

      for (const r of rows) {
        const obs = observationsFor(db, r);
        db.prepare("INSERT OR IGNORE INTO bug_occurrences (id, bug_id, test_run_id, test_result_id, browser, viewport, actual_result, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          randomUUID(), bugId, runId, r.resultId, r.browser, r.viewport, redactText(r.actual).slice(0, 2000), r.executedAt,
        );
        insertEvidence(db, bugId, r, obs, selectorFor(db, r.resultId));
      }
      db.prepare(
        `UPDATE bugs SET occurrence_count = (SELECT COUNT(*) FROM bug_occurrences WHERE bug_id = ?), last_seen_run_id = ?, last_seen_at = ?, test_run_id = ?,
           updated_at = ? WHERE id = ?`,
      ).run(bugId, runId, rows[rows.length - 1].executedAt, runId, ts, bugId);
      summary.bugIds.push(bugId);
    }
  });
  tx();
  return summary;
}
