import { randomUUID } from "node:crypto";
import { getTestModule } from "@/lib/constants/testing";
import type { SqlExecutor, SqlValue } from "@/lib/database/sql/executor";
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

async function loadFailures(sql: SqlExecutor, runId: string): Promise<FailureRow[]> {
  const rows = await sql.all<Row>(
    `SELECT tr.id AS result_id, tr.test_run_id, r.project_id, tr.page_id, COALESCE(pg.url, tr.url, tc.page_url) AS page_url, pg.name AS page_name,
         pg.page_type, tr.browser, tr.viewport, tr.actual_result, tr.executed_at, tr.evidence, tr.verifications,
         tc.id AS case_id, tc.case_key, tc.module, tc.title, tc.section, tc.scenario_type, tc.feature, tc.element, tc.steps, tc.expected_result
       FROM test_results tr
       JOIN test_cases tc ON tc.id = tr.test_case_id
       JOIN test_runs r ON r.id = tr.test_run_id
       LEFT JOIN pages pg ON pg.id = tr.page_id
       WHERE tr.test_run_id = ? AND tr.status = 'FAIL' AND tr.executed_at IS NOT NULL AND tc.case_key IS NOT NULL
       ORDER BY tr.created_at, tr.rowid`,
    [runId],
  );
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
async function selectorFor(sql: SqlExecutor, resultId: string): Promise<string | null> {
  for (const query of [
    "SELECT selector AS s FROM ui_results WHERE test_result_id = ? AND selector IS NOT NULL LIMIT 1",
    "SELECT target_selector AS s FROM accessibility_results WHERE test_result_id = ? AND target_selector IS NOT NULL LIMIT 1",
    "SELECT selector AS s FROM typography_results WHERE test_result_id = ? LIMIT 1",
  ]) {
    const row = await sql.get<Row>(query, [resultId]);
    if (row?.s) return String(row.s);
  }
  return null;
}

async function axeImpactFor(sql: SqlExecutor, resultId: string): Promise<string | null> {
  const row = await sql.get<Row>(
    `SELECT impact FROM accessibility_results WHERE test_result_id = ? AND impact IS NOT NULL
       ORDER BY CASE impact WHEN 'critical' THEN 0 WHEN 'serious' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END LIMIT 1`,
    [resultId],
  );
  return str(row?.impact);
}

type Observations = { console: Row[]; network: Row[] };

/** Console errors and failed requests recorded for the same page, run, browser and viewport. */
async function observationsFor(sql: SqlExecutor, f: FailureRow): Promise<Observations> {
  if (!f.pageId) return { console: [], network: [] };
  const scope = [f.runId, f.pageId, f.browser, f.viewport];
  const console = await sql.all<Row>(
    "SELECT level, message, source_url, logged_at FROM console_results WHERE test_run_id = ? AND page_id = ? AND browser IS NOT DISTINCT FROM ? AND viewport IS NOT DISTINCT FROM ? AND level = 'error' LIMIT 20",
    scope,
  );
  const network = await sql.all<Row>(
    "SELECT method, url, resource_type, status_code, failure_text, error_category FROM network_results WHERE test_run_id = ? AND page_id = ? AND browser IS NOT DISTINCT FROM ? AND viewport IS NOT DISTINCT FROM ? LIMIT 20",
    scope,
  );
  return { console, network };
}

async function screenshotKind(sql: SqlExecutor, key: string): Promise<"VIEWPORT" | "FULL_PAGE" | "ELEMENT"> {
  const row = await sql.get<Row>("SELECT kind FROM screenshots WHERE storage_key = ?", [key]);
  return (str(row?.kind) as "VIEWPORT" | "FULL_PAGE" | "ELEMENT" | null) ?? "VIEWPORT";
}

async function nextBugCode(sql: SqlExecutor, projectId: string): Promise<string> {
  const row = (await sql.get<Row>("SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) AS n FROM bugs WHERE project_id = ? AND code LIKE 'BUG-%'", [projectId])) as Row;
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

function buildTechnicalDetails(f: FailureRow, obs: Observations): string {
  const parts: string[] = [];
  if (f.verifications.length) parts.push(`Observations:\n- ${f.verifications.join("\n- ")}`);
  for (const e of f.evidence) if (e.type !== "screenshot" && e.content) parts.push(`${e.label}:\n${e.content}`);
  if (obs.console.length) parts.push(`Console errors on this page (${f.browser}, ${f.viewport}):\n${obs.console.map((c) => `- ${c.message}`).join("\n")}`);
  if (obs.network.length) {
    parts.push(`Failed requests on this page (${f.browser}, ${f.viewport}):\n${obs.network.map((n) => `- ${n.method} ${n.url} → ${n.status_code ?? n.failure_text} (${n.resource_type})`).join("\n")}`);
  }
  return redactText(parts.join("\n\n")).slice(0, 12_000);
}

async function insertEvidence(sql: SqlExecutor, bugId: string, f: FailureRow, obs: Observations, selector: string | null): Promise<void> {
  const exists = await sql.get("SELECT 1 FROM bug_evidence WHERE bug_id = ? AND test_result_id = ? LIMIT 1", [bugId, f.resultId]);
  if (exists) return;
  const base = (type: string, label: string, storageKey: string | null, content: string | null, kind: string | null, screenshotId: string | null = null) =>
    sql.run(
      `INSERT INTO bug_evidence (id, bug_id, evidence_type, screenshot_id, storage_key, content, label, screenshot_kind, test_run_id, test_result_id, url, browser, viewport, selector, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), bugId, type, screenshotId, storageKey, content, label, kind, f.runId, f.resultId, f.pageUrl, f.browser, f.viewport, selector, f.executedAt],
    );
  const seenKeys = new Set<string>();
  for (const e of f.evidence) {
    if (e.type === "screenshot" && e.storageKey) {
      seenKeys.add(e.storageKey);
      const shot = await sql.get<Row>("SELECT id FROM screenshots WHERE storage_key = ?", [e.storageKey]);
      await base("SCREENSHOT", e.label, e.storageKey, null, await screenshotKind(sql, e.storageKey), str(shot?.id));
    } else if (e.content) {
      const type = e.type === "console" ? "CONSOLE_LOG" : e.type === "network" || e.type === "http" ? "NETWORK_LOG" : e.type === "dom" ? "HTML_SNAPSHOT" : "OTHER";
      await base(type, e.label, null, redactText(e.content), null);
    }
  }
  // Full-page screenshot taken for this page/browser/viewport after the failures were recorded.
  if (f.pageId) {
    const full = await sql.get<Row>(
      "SELECT id, storage_key FROM screenshots WHERE test_run_id = ? AND page_id = ? AND browser IS NOT DISTINCT FROM ? AND viewport IS NOT DISTINCT FROM ? AND kind = 'FULL_PAGE' ORDER BY captured_at DESC LIMIT 1",
      [f.runId, f.pageId, f.browser, f.viewport],
    );
    if (full && !seenKeys.has(String(full.storage_key))) await base("SCREENSHOT", "Full page after testing", String(full.storage_key), null, "FULL_PAGE", String(full.id));
  }
  if (obs.console.length) await base("CONSOLE_LOG", "Console errors", null, redactText(obs.console.map((c) => `[${c.logged_at}] ${c.message}${c.source_url ? ` (${c.source_url})` : ""}`).join("\n")).slice(0, 8000), null);
  if (obs.network.length) await base("NETWORK_LOG", "Failed requests", null, redactText(obs.network.map((n) => `${n.method} ${n.url} → ${n.status_code ?? n.failure_text} [${n.error_category}]`).join("\n")).slice(0, 8000), null);
}

/**
 * Creates or updates bugs from the verified failures (status FAIL, executed, with evidence) of a
 * run. Never creates a bug from a WARNING, NOT EXECUTED or NOT APPLICABLE result. Idempotent:
 * re-running it for the same run adds nothing new. Never marks a bug as resolved. All changes for a run are
 * written in one transaction.
 */
export async function createBugsForRun(sql: SqlExecutor, runId: string, detector: DuplicateDetector = new DeterministicDuplicateDetector()): Promise<BugEngineSummary> {
  const failures = (await loadFailures(sql, runId)).filter((f) => f.evidence.length > 0 && f.pageUrl);
  const summary: BugEngineSummary = { failures: failures.length, created: 0, updated: 0, reopened: 0, bugIds: [] };
  if (!failures.length) return summary;

  const groups = new Map<string, FailureRow[]>();
  for (const f of failures) {
    const fp = bugFingerprint(f.pageUrl, f.caseKey);
    groups.set(fp, [...(groups.get(fp) ?? []), f]);
  }

  await sql.transaction(async (tx) => {
    for (const [fingerprint, rows] of groups) {
      const first = rows[0];
      const projectBugs = (await tx.all<Row>("SELECT id, fingerprint, page_url, test_type, selector, element, status FROM bugs WHERE project_id = ?", [first.projectId])).map((b) => ({
        id: String(b.id),
        fingerprint: String(b.fingerprint ?? ""),
        pageUrl: str(b.page_url),
        testType: str(b.test_type),
        selector: str(b.selector),
        element: str(b.element),
        status: String(b.status),
      }));
      const selector = await selectorFor(tx, first.resultId);
      const duplicate = detector.find({ fingerprint, pageUrl: first.pageUrl, testType: first.module, selector, element: first.element }, projectBugs).find((m) => m.kind === "duplicate");
      const ts = now();
      let bugId: string;

      if (duplicate) {
        bugId = duplicate.bugId;
        const existing = projectBugs.find((b) => b.id === bugId)!;
        const newlySeen: FailureRow[] = [];
        for (const r of rows) if (!(await tx.get("SELECT 1 FROM bug_occurrences WHERE bug_id = ? AND test_result_id = ?", [bugId, r.resultId]))) newlySeen.push(r);
        if (!newlySeen.length) continue;
        summary.updated++;
        if (existing.status === "RESOLVED" || existing.status === "CLOSED") {
          await tx.run("UPDATE bugs SET status = 'REOPENED', updated_at = ? WHERE id = ?", [ts, bugId]);
          await tx.run("INSERT INTO bug_status_history (id, bug_id, from_status, to_status, note, source, changed_at) VALUES (?, ?, ?, 'REOPENED', ?, 'ENGINE', ?)", [
            randomUUID(),
            bugId,
            existing.status,
            `The same failure was observed again in run ${runId} with new evidence.`,
            ts,
          ]);
          summary.reopened++;
        }
      } else {
        const actual = redactText(first.actual);
        const evidenceText = [first.actual, ...first.evidence.map((e) => e.content ?? "")].join("\n");
        const sev = classifySeverity({
          module: first.module, caseKey: first.caseKey, title: first.title, section: first.section, actual, viewport: first.viewport, pageType: first.pageType,
          axeImpact: await axeImpactFor(tx, first.resultId), httpStatus: httpStatusFrom(evidenceText),
        });
        const prio = priorityFor(sev.severity, first.pageType);
        const shot = first.evidence.find((e) => e.type === "screenshot" && e.storageKey)?.storageKey ?? null;
        const steps = [`Open ${first.pageUrl} in ${first.browser ?? "the browser"} at ${first.viewport ?? "the tested viewport"}.`, ...first.steps];
        bugId = randomUUID();
        const values: SqlValue[] = [
          bugId, first.projectId, await nextBugCode(tx, first.projectId), runId, first.resultId, first.caseId, first.pageId,
          redactText(`${moduleName(first.module)}: ${first.title} (${pathOf(first.pageUrl)})`).slice(0, 300), actual, first.pageName, redactText(first.pageUrl),
          first.section, first.module, first.scenarioType, sev.severity, `${sev.reason} Priority: ${prio.reason}.`, prio.priority,
          steps.map((st, i) => `${i + 1}. ${st}`).join("\n"), first.expected, actual, redactText(first.element ?? ""), selector,
          buildTechnicalDetails(first, await observationsFor(tx, first)), shot, first.browser, first.viewport, fingerprint, runId, runId, first.executedAt, ts, ts,
        ];
        await tx.run(
          `INSERT INTO bugs (id, project_id, code, test_run_id, test_result_id, test_case_id, page_id, title, description, page_name, page_url, section, test_type,
             scenario_type, severity, severity_reason, priority, status, steps_to_reproduce, expected_result, actual_result, element, selector, technical_details,
             screenshot_key, browser, viewport, fingerprint, first_seen_run_id, last_seen_run_id, last_seen_at, occurrence_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          values,
        );
        await tx.run("INSERT INTO bug_status_history (id, bug_id, from_status, to_status, note, source, changed_at) VALUES (?, ?, NULL, 'OPEN', ?, 'ENGINE', ?)", [
          randomUUID(),
          bugId,
          `Created from a verified failure in run ${runId}.`,
          ts,
        ]);
        summary.created++;
      }

      for (const r of rows) {
        const obs = await observationsFor(tx, r);
        // An occurrence is recorded once per bug and result (unique), so re-running adds nothing.
        await tx.run(
          "INSERT INTO bug_occurrences (id, bug_id, test_run_id, test_result_id, browser, viewport, actual_result, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          [randomUUID(), bugId, runId, r.resultId, r.browser, r.viewport, redactText(r.actual).slice(0, 2000), r.executedAt],
        );
        await insertEvidence(tx, bugId, r, obs, await selectorFor(tx, r.resultId));
      }
      await tx.run(
        `UPDATE bugs SET occurrence_count = (SELECT COUNT(*) FROM bug_occurrences WHERE bug_id = ?), last_seen_run_id = ?, last_seen_at = ?, test_run_id = ?,
           updated_at = ? WHERE id = ?`,
        [bugId, runId, rows[rows.length - 1].executedAt, runId, ts, bugId],
      );
      summary.bugIds.push(bugId);
    }
  });
  return summary;
}
