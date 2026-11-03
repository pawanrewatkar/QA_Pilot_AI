import { randomUUID } from "node:crypto";
import type { CrawledPage, CrawlProgress } from "@/lib/crawler/crawler";
import { DETAIL_COLUMNS, type DetailRow } from "@/lib/testing/details";
import type { FinalizedOutcome } from "@/lib/testing/outcome";
import type { ExternalObservationInput, StoredExternalCase } from "@/lib/external-tests/module";
import type { BrowserName, CrawlConfig, TestRunOptions, TestRunStatus } from "@/types";
import type { SqlExecutor, SqlValue } from "../sql/executor";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export interface RunSnapshot {
  configurationName: string | null;
  modules: string[];
  browsers: BrowserName[];
  viewports: string[];
  pageIds: string[];
}

export interface RunForExecution {
  id: string;
  projectId: string;
  status: TestRunStatus;
  snapshot: RunSnapshot;
  options: TestRunOptions;
  project: { name: string; websiteUrl: string; testEmail: string | null; figmaUrl: string | null };
  pages: { id: string; url: string }[];
  runType: "WEBSITE" | "EXTERNAL_TEST_CASE";
}

/**
 * Write-side persistence used by the worker (crawler + test engine), on SqlExecutor: the same code runs on SQLite
 * (local) and PostgreSQL (hosted). Kept separate from the read-oriented DatabaseProvider.
 */
export class EngineStore {
  constructor(private readonly db: SqlExecutor) {}

  /** The executor, for engine post-processing (bugs, reports) that shares this store's database. */
  get sql(): SqlExecutor {
    return this.db;
  }

  // ---------------------------------------------------------------- crawl runs

  async getCrawlRun(id: string): Promise<{ id: string; projectId: string; status: TestRunStatus; config: CrawlConfig; startUrl: string } | null> {
    const row = await this.db.get<Row>("SELECT * FROM crawl_runs WHERE id = ?", [id]);
    if (!row) return null;
    return { id: String(row.id), projectId: String(row.project_id), status: row.status as TestRunStatus, config: JSON.parse(String(row.config)), startUrl: String(row.start_url) };
  }

  async markCrawlRunning(id: string): Promise<void> {
    await this.db.run("UPDATE crawl_runs SET status = 'RUNNING', started_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'", [now(), now(), id]);
  }

  async setCrawlResolvedUrl(id: string, url: string): Promise<void> {
    await this.db.run("UPDATE crawl_runs SET resolved_start_url = ?, updated_at = ? WHERE id = ?", [url, now(), id]);
  }

  async updateCrawlProgress(id: string, p: CrawlProgress): Promise<void> {
    await this.db.run(
      `UPDATE crawl_runs SET pages_discovered = ?, pages_crawled = ?, pages_failed = ?, pages_skipped = ?, current_url = ?,
           current_depth = ?, max_depth_reached = ?, updated_at = ? WHERE id = ?`,
      [p.discovered, p.crawled, p.failed, p.skipped, p.currentUrl, p.currentDepth, p.maxDepthReached, now(), id],
    );
  }

  async isCrawlCancelRequested(id: string): Promise<boolean> {
    const row = await this.db.get<Row>("SELECT cancel_requested FROM crawl_runs WHERE id = ?", [id]);
    return !row || Number(row.cancel_requested) === 1;
  }

  async finishCrawl(id: string, status: Exclude<TestRunStatus, "PENDING" | "RUNNING">, error: string | null): Promise<void> {
    await this.db.run("UPDATE crawl_runs SET status = ?, error_message = ?, current_url = NULL, completed_at = ?, updated_at = ? WHERE id = ?", [status, error, now(), now(), id]);
  }

  /** Inserts or updates a discovered page; discovery sources are merged, user selection is preserved. */
  async upsertCrawledPage(projectId: string, crawlRunId: string, page: CrawledPage): Promise<string> {
    const existing = await this.db.get<Row>("SELECT id, discovery_sources FROM pages WHERE project_id = ? AND normalized_url = ?", [projectId, page.normalizedUrl]);
    const ts = now();
    const via = page.sources.includes("manual") ? "MANUAL" : page.sources.some((s) => s === "sitemap" || s === "robots-sitemap") && !page.sources.some((s) => !["sitemap", "robots-sitemap"].includes(s)) ? "SITEMAP" : "CRAWL";
    if (existing) {
      const merged = [...new Set([...(JSON.parse(String(existing.discovery_sources)) as string[]), ...page.sources])];
      // Two-argument MIN is SQLite's scalar minimum; PostgreSQL calls it LEAST.
      const least = this.db.dialect === "postgres" ? "LEAST" : "MIN";
      await this.db.run(
        `UPDATE pages SET url = ?, title = COALESCE(?, title), name = ?, description = COALESCE(?, description), http_status = COALESCE(?, http_status),
             depth = ${least}(COALESCE(depth, ?), ?), page_type = CASE WHEN ? = 'CRAWLED' THEN ? ELSE page_type END,
             page_type_confidence = CASE WHEN ? = 'CRAWLED' THEN ? ELSE page_type_confidence END,
             crawl_status = ?, discovery_sources = ?, final_url = ?, content_type = COALESCE(?, content_type), error_message = ?,
             last_crawl_run_id = ?, last_seen_at = ?
           WHERE id = ?`,
        [
          page.url, page.title, page.name, page.description, page.httpStatus, page.depth, page.depth,
          page.crawlStatus, page.pageType, page.crawlStatus, page.pageTypeConfidence,
          page.crawlStatus, JSON.stringify(merged), page.finalUrl, page.contentType, page.errorMessage, crawlRunId, ts, String(existing.id),
        ],
      );
      return String(existing.id);
    }
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO pages (id, project_id, url, normalized_url, title, name, description, http_status, discovered_via, depth, page_type,
           page_type_confidence, crawl_status, discovery_sources, final_url, content_type, error_message, last_crawl_run_id, first_seen_at, last_seen_at, is_selected)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, projectId, page.url, page.normalizedUrl, page.title, page.name, page.description, page.httpStatus, via, page.depth, page.pageType,
        page.pageTypeConfidence, page.crawlStatus, JSON.stringify(page.sources), page.finalUrl, page.contentType, page.errorMessage, crawlRunId, ts, ts,
        // Pages that failed or were skipped start deselected; later crawls never override a user's choice.
        page.crawlStatus === "FAILED" || page.crawlStatus === "SKIPPED" ? 0 : 1,
      ],
    );
    return id;
  }

  // ---------------------------------------------------------------- test runs

  async getRunForExecution(runId: string): Promise<RunForExecution | null> {
    const row = await this.db.get<Row>(`SELECT r.*, p.name AS project_name, p.website_url, p.test_email, p.figma_url FROM test_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`, [runId]);
    if (!row) return null;
    const snapshot = JSON.parse(String(row.config_snapshot)) as RunSnapshot;
    const pages: { id: string; url: string }[] = [];
    for (const pid of snapshot.pageIds ?? []) {
      const p = await this.db.get<Row>("SELECT id, url FROM pages WHERE id = ? AND project_id = ?", [pid, row.project_id as SqlValue]);
      if (p) pages.push({ id: String(p.id), url: String(p.url) });
    }
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      status: row.status as TestRunStatus,
      snapshot,
      options: JSON.parse(String(row.options)) as TestRunOptions,
      project: { name: String(row.project_name), websiteUrl: String(row.website_url), testEmail: row.test_email === null ? null : String(row.test_email), figmaUrl: row.figma_url === null ? null : String(row.figma_url) },
      pages,
      runType: String(row.run_type ?? "WEBSITE") as RunForExecution["runType"],
    };
  }

  // ---------------------------------------------------------------- external test cases

  async getExternalCases(runId: string): Promise<StoredExternalCase[]> {
    return (await this.db.all<Row>("SELECT * FROM external_test_cases WHERE test_run_id = ? ORDER BY row_number", [runId])).map((r) => ({
      id: String(r.id),
      rowNumber: Number(r.row_number),
      caseRef: r.case_ref === null ? null : String(r.case_ref),
      title: String(r.title),
      steps: r.steps === null ? null : String(r.steps),
      expected: r.expected === null ? null : String(r.expected),
      url: r.url === null ? null : String(r.url),
      testData: r.test_data === null ? null : String(r.test_data),
      preconditions: r.preconditions === null ? null : String(r.preconditions),
    }));
  }

  /** One case in one browser × viewport; a retry of the same combination replaces the earlier observation. */
  async saveExternalObservation(runId: string, o: ExternalObservationInput): Promise<void> {
    await this.db.run(
      `INSERT INTO external_test_observations (id, external_case_id, test_run_id, browser, viewport, status, actual_result, screenshot_key, duration_ms, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (external_case_id, browser, viewport) DO UPDATE SET status = excluded.status, actual_result = excluded.actual_result,
           screenshot_key = excluded.screenshot_key, duration_ms = excluded.duration_ms, observed_at = excluded.observed_at`,
      [randomUUID(), o.caseId, runId, o.browser, o.viewport, o.status, o.actual.slice(0, 20_000), o.screenshotKey, o.durationMs, now()],
    );
  }

  async markRunRunning(runId: string, total: number): Promise<void> {
    await this.db.run("UPDATE test_runs SET status = 'RUNNING', started_at = ?, progress_total = ?, progress_completed = 0, updated_at = ? WHERE id = ?", [now(), total, now(), runId]);
  }

  async updateRunProgress(runId: string, fields: { completed?: number; currentPageUrl?: string | null; currentTest?: string | null }): Promise<void> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (fields.completed !== undefined) {
      sets.push("progress_completed = ?");
      params.push(fields.completed);
    }
    if (fields.currentPageUrl !== undefined) {
      sets.push("current_page_url = ?");
      params.push(fields.currentPageUrl);
    }
    if (fields.currentTest !== undefined) {
      sets.push("current_test = ?");
      params.push(fields.currentTest);
    }
    if (!sets.length) return;
    await this.db.run(`UPDATE test_runs SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, now(), runId]);
  }

  async isRunCancelRequested(runId: string): Promise<boolean> {
    const row = await this.db.get<Row>("SELECT cancel_requested FROM test_runs WHERE id = ?", [runId]);
    return !row || Number(row.cancel_requested) === 1;
  }

  async finishRun(runId: string, status: Exclude<TestRunStatus, "PENDING" | "RUNNING">, error: string | null): Promise<void> {
    await this.db.run("UPDATE test_runs SET status = ?, error_message = ?, current_page_url = NULL, current_test = NULL, completed_at = ?, updated_at = ? WHERE id = ?", [status, error, now(), now(), runId]);
  }

  async ensureRunPage(runId: string, pageId: string): Promise<string> {
    const existing = await this.db.get<Row>("SELECT id FROM test_run_pages WHERE test_run_id = ? AND page_id = ?", [runId, pageId]);
    if (existing) return String(existing.id);
    const id = randomUUID();
    await this.db.run("INSERT INTO test_run_pages (id, test_run_id, page_id, status, started_at) VALUES (?, ?, ?, 'RUNNING', ?)", [id, runId, pageId, now()]);
    return id;
  }

  async finishRunPage(runPageId: string, status: "COMPLETED" | "FAILED" | "CANCELLED", error: string | null): Promise<void> {
    await this.db.run("UPDATE test_run_pages SET status = ?, error_message = ?, completed_at = ? WHERE id = ?", [status, error, now(), runPageId]);
  }

  /**
   * Persists one finalized outcome: the browser-independent case (created once), this execution's
   * result, and any measurement rows for the per-check tables, in one transaction. Returns the result id.
   */
  async recordOutcome(input: { runId: string; projectId: string; pageId: string; pageUrl: string; runPageId: string; browser: BrowserName; viewport: string; outcome: FinalizedOutcome }): Promise<string> {
    const { outcome: o } = input;
    const caseKey = `${input.pageId}|${o.spec.key}`;
    return this.db.transaction(async (tx) => {
      let caseId = (await tx.get<Row>("SELECT id FROM test_cases WHERE test_run_id = ? AND case_key = ?", [input.runId, caseKey]))?.id as string | undefined;
      if (!caseId) {
        // Counts come back as text from PostgreSQL: convert before doing arithmetic.
        const count = Number(((await tx.get<Row>("SELECT COUNT(*) AS c FROM test_cases WHERE test_run_id = ?", [input.runId])) as Row).c);
        caseId = randomUUID();
        await tx.run(
          `INSERT INTO test_cases (id, project_id, test_run_id, page_id, module, title, description, preconditions, steps, expected_result, source,
               case_key, code, page_url, section, scenario_type, feature, element, test_data, expectation_source)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'RULE', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            caseId, input.projectId, input.runId, input.pageId, o.spec.module, o.spec.title, o.spec.preconditions ?? null, JSON.stringify(o.spec.steps),
            o.spec.expected, caseKey, `TC-${String(count + 1).padStart(4, "0")}`, input.pageUrl, o.spec.section, o.spec.scenarioType, o.spec.feature,
            o.spec.element, o.spec.testData ?? null, o.spec.expectationSource ?? "DETECTED_FUNCTIONALITY",
          ],
        );
      }
      const resultId = randomUUID();
      await tx.run(
        `INSERT INTO test_results (id, test_run_id, test_case_id, test_run_page_id, page_id, url, browser, viewport, status, actual_result, message,
             duration_ms, executed_at, evidence, verifications)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          resultId, input.runId, caseId, input.runPageId, input.pageId, input.pageUrl, input.browser, input.viewport, o.status, o.actual,
          o.adjustment, o.durationMs, o.executedAt, JSON.stringify(o.evidence), JSON.stringify(o.verifications),
        ],
      );
      for (const row of o.details ?? []) await this.insertDetail(tx, input.runId, input.pageId, resultId, row);
      return resultId;
    });
  }

  /** Inserts one measurement row using only whitelisted columns (see lib/testing/details.ts). */
  private async insertDetail(tx: SqlExecutor, runId: string, pageId: string, resultId: string, row: DetailRow): Promise<void> {
    const allowed = DETAIL_COLUMNS[row.table] as readonly string[];
    const entries = Object.entries(row.values).filter(([k, v]) => allowed.includes(k) && v !== undefined);
    const cols = ["id", "test_run_id", "page_id", "test_result_id", ...entries.map(([k]) => k)];
    const values = [randomUUID(), runId, pageId, resultId, ...entries.map(([, v]) => (typeof v === "string" ? v.slice(0, 20_000) : v))] as SqlValue[];
    await tx.run(`INSERT INTO ${row.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values);
  }

  async saveScreenshot(input: { runId: string; pageId: string; storageKey: string; browser: string; viewport: string; width: number; height: number; kind?: "VIEWPORT" | "FULL_PAGE" | "ELEMENT"; label?: string }): Promise<void> {
    await this.db.run("INSERT INTO screenshots (id, test_run_id, page_id, storage_key, browser, viewport, width, height, captured_at, kind, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      randomUUID(),
      input.runId,
      input.pageId,
      input.storageKey,
      input.browser,
      input.viewport,
      input.width,
      input.height,
      now(),
      input.kind ?? "VIEWPORT",
      input.label ?? null,
    ]);
  }

  /** Stores console output and failed requests observed while a page was tested in one browser/viewport. */
  async saveObservations(input: {
    runId: string;
    pageId: string;
    browser: string;
    viewport: string;
    console: { level: string; message: string; sourceUrl: string | null; line: number | null; column: number | null; at: string }[];
    network: { url: string; method: string; resourceType: string; status: number | null; failure: string | null; durationMs: number | null; at: string }[];
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const e of input.console.filter((x) => x.level === "error" || x.level === "warning").slice(0, 300)) {
        await tx.run(
          "INSERT INTO console_results (id, test_run_id, page_id, level, message, source_url, line_number, column_number, logged_at, browser, viewport) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [randomUUID(), input.runId, input.pageId, e.level, e.message, e.sourceUrl, e.line, e.column, e.at, input.browser, input.viewport],
        );
      }
      const interesting = input.network.filter((e) => (e.failure && !/ERR_ABORTED|NS_BINDING_ABORTED|blockedbyclient/i.test(e.failure)) || (e.status !== null && e.status >= 400));
      for (const e of interesting.slice(0, 300)) {
        await tx.run(
          "INSERT INTO network_results (id, test_run_id, page_id, url, method, resource_type, status_code, failure_text, duration_ms, recorded_at, browser, viewport, error_category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [randomUUID(), input.runId, input.pageId, e.url.slice(0, 2000), e.method, e.resourceType, e.status, e.failure, e.durationMs, e.at, input.browser, input.viewport, classifyNetworkFailure(e)],
        );
      }
    });
  }

  /** The project's most recent reference document, if any. */
  async getReferenceDocument(projectId: string): Promise<{ id: string; fileName: string; mimeType: string; storageKey: string } | null> {
    const row = await this.db.get<Row>("SELECT id, file_name, mime_type, storage_key FROM documents WHERE project_id = ? AND kind = 'REFERENCE' ORDER BY created_at DESC, rowid DESC LIMIT 1", [projectId]);
    return row ? { id: String(row.id), fileName: String(row.file_name), mimeType: String(row.mime_type), storageKey: String(row.storage_key) } : null;
  }

  // ---------------------------------------------------------------- form ledger

  /** Every form submission recorded for the project (the run executor keeps them in memory for the run). */
  async listFormSubmissions(projectId: string): Promise<{ kind: string; fingerprint: string }[]> {
    return (await this.db.all<Row>("SELECT form_kind, form_fingerprint FROM form_submissions WHERE project_id = ?", [projectId])).map((r) => ({
      kind: String(r.form_kind),
      fingerprint: String(r.form_fingerprint),
    }));
  }

  async hasFormSubmission(projectId: string, kind: string, fingerprint: string): Promise<boolean> {
    return !!(await this.db.get("SELECT 1 FROM form_submissions WHERE project_id = ? AND form_kind = ? AND form_fingerprint = ? LIMIT 1", [projectId, kind, fingerprint]));
  }

  async recordFormSubmission(projectId: string, runId: string, kind: string, fingerprint: string, pageUrl: string): Promise<void> {
    await this.db.run("INSERT INTO form_submissions (id, project_id, test_run_id, form_kind, form_fingerprint, page_url, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      randomUUID(),
      projectId,
      runId,
      kind,
      fingerprint,
      pageUrl,
      now(),
    ]);
  }

  // ---------------------------------------------------------------- worker liveness & recovery

  async heartbeat(workerId: string, hostname: string, pid: number, handlers: string[], startedAt: string): Promise<void> {
    await this.db.run(
      `INSERT INTO worker_heartbeats (worker_id, hostname, pid, handlers, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, handlers = excluded.handlers`,
      [workerId, hostname, pid, JSON.stringify(handlers), startedAt, now()],
    );
  }

  async removeHeartbeat(workerId: string): Promise<void> {
    await this.db.run("DELETE FROM worker_heartbeats WHERE worker_id = ?", [workerId]);
  }

  /**
   * Marks work owned by workers that stopped heart-beating as FAILED, so runs never stay RUNNING
   * forever after a crash. Returns the number of recovered jobs.
   */
  async recoverAbandonedWork(staleAfterMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const rows = await this.db.all<Row>(
      `SELECT j.id, j.type, j.payload FROM jobs j
         WHERE j.status = 'RUNNING' AND NOT EXISTS (SELECT 1 FROM worker_heartbeats h WHERE h.worker_id = j.locked_by AND h.last_seen_at >= ?)`,
      [cutoff],
    );
    const message = "The worker stopped before this job finished.";
    await this.db.transaction(async (tx) => {
      for (const r of rows) {
        await tx.run("UPDATE jobs SET status = 'FAILED', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?", [message, now(), String(r.id)]);
        const payload = JSON.parse(String(r.payload)) as { crawlRunId?: string; testRunId?: string; reportBundleId?: string };
        if (payload.crawlRunId) await tx.run("UPDATE crawl_runs SET status = 'FAILED', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('PENDING','RUNNING')", [message, now(), now(), payload.crawlRunId]);
        if (payload.reportBundleId) await tx.run("UPDATE report_bundles SET status = 'FAILED', error_message = ?, completed_at = ? WHERE id = ? AND status = 'GENERATING'", [message, now(), payload.reportBundleId]);
        if (payload.testRunId) await tx.run("UPDATE test_runs SET status = 'FAILED', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('PENDING','RUNNING')", [message, now(), now(), payload.testRunId]);
      }
      await tx.run("DELETE FROM worker_heartbeats WHERE last_seen_at < ?", [cutoff]);
    });
    return rows.length;
  }

  async recordActivity(projectId: string | null, entityType: string, entityId: string, action: string, summary: string): Promise<void> {
    await this.db.run("INSERT INTO activity_log (id, project_id, entity_type, entity_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), projectId, entityType, entityId, action, summary, now()]);
  }
}

/** Coarse category for a failed request, used for filtering network results. */
export function classifyNetworkFailure(e: { status: number | null; failure: string | null; resourceType: string }): string {
  if (e.failure && /CORS|cross-origin|Access-Control/i.test(e.failure)) return "CORS";
  if (e.status === 404 || e.status === 410) return "NOT_FOUND";
  if (e.status !== null && e.status >= 500) return "SERVER_ERROR";
  if (e.status !== null && e.status >= 400) return "CLIENT_ERROR";
  if (e.failure) return "NETWORK_ERROR";
  return "OTHER";
}
