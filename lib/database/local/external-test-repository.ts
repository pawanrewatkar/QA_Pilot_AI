import { randomUUID } from "node:crypto";
import { aggregateStatus } from "@/lib/external-tests/status";
import { EXTERNAL_STATUSES, type ExternalCaseRecord, type ExternalCounts, type ExternalExecutionRecord, type ExternalStatus, type NewExternalExecution } from "@/lib/external-tests/types";
import type { ExternalTestRepository } from "../provider";
import { createRunAndEnqueue } from "./engine-repositories";
import type { SqliteDatabase } from "./sqlite-client";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const emptyCounts = (): ExternalCounts => Object.fromEntries(EXTERNAL_STATUSES.map((s) => [s, 0])) as ExternalCounts;

export class LocalExternalTestRepository implements ExternalTestRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: NewExternalExecution): Promise<string> {
    let runId = "";
    this.db.transaction(() => {
      // The execution is a test run of type EXTERNAL_TEST_CASE running the "external" module, so progress,
      // cancellation, evidence, bugs, reports and history all use the existing run infrastructure.
      runId = createRunAndEnqueue(this.db, {
        projectId: input.projectId,
        configurationId: null,
        name: input.name,
        modules: ["external"],
        browsers: input.browsers,
        viewports: input.viewports,
        pageIds: [input.pageId],
        configurationName: null,
        options: { allowFormSubmission: input.allowFormSubmission, maxLinksPerPage: 1, navigationTimeoutMs: input.navigationTimeoutMs, reports: { formats: [] } },
        runType: "EXTERNAL_TEST_CASE",
      });
      this.db
        .prepare(
          `INSERT INTO external_test_executions (test_run_id, project_id, website_url, source_kind, source_name, source_storage_key, worksheet, header_row, mapping, output_mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, input.projectId, input.websiteUrl, input.source.kind, input.source.name, input.source.storageKey, input.worksheet, input.headerRow, JSON.stringify(input.mapping), input.outputMode, new Date().toISOString());
      const insert = this.db.prepare(
        "INSERT INTO external_test_cases (id, test_run_id, row_number, case_ref, title, steps, expected, url, test_data, preconditions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const c of input.cases) insert.run(randomUUID(), runId, c.rowNumber, c.caseRef, c.title, c.steps, c.expected, c.url, c.testData, c.preconditions);
    })();
    return runId;
  }

  private caseStatuses(runIds: string[]) {
    // Live status per case: the final status once set, otherwise the worst status observed so far.
    const out = new Map<string, { counts: ExternalCounts; completed: number; total: number }>();
    if (!runIds.length) return out;
    const marks = runIds.map(() => "?").join(",");
    const cases = this.db.prepare(`SELECT id, test_run_id, status FROM external_test_cases WHERE test_run_id IN (${marks})`).all(...runIds) as Row[];
    const obs = this.db.prepare(`SELECT external_case_id, status FROM external_test_observations WHERE test_run_id IN (${marks})`).all(...runIds) as Row[];
    const combos = new Map(
      (this.db.prepare(`SELECT id, config_snapshot FROM test_runs WHERE id IN (${marks})`).all(...runIds) as Row[]).map((r) => {
        const s = JSON.parse(String(r.config_snapshot)) as { browsers?: string[]; viewports?: string[] };
        return [String(r.id), (s.browsers?.length ?? 1) * (s.viewports?.length ?? 1)];
      }),
    );
    const byCase = new Map<string, ExternalStatus[]>();
    for (const o of obs) {
      const list = byCase.get(String(o.external_case_id)) ?? [];
      list.push(String(o.status) as ExternalStatus);
      byCase.set(String(o.external_case_id), list);
    }
    for (const c of cases) {
      const runId = String(c.test_run_id);
      const entry = out.get(runId) ?? { counts: emptyCounts(), completed: 0, total: 0 };
      entry.total++;
      const seen = byCase.get(String(c.id)) ?? [];
      const status = (str(c.status) as ExternalStatus | null) ?? (seen.length >= (combos.get(runId) ?? 1) ? aggregateStatus(seen) : null);
      if (status) {
        entry.counts[status]++;
        entry.completed++;
      }
      out.set(runId, entry);
    }
    return out;
  }

  private map(rows: Row[]): ExternalExecutionRecord[] {
    const stats = this.caseStatuses(rows.map((r) => String(r.test_run_id)));
    return rows.map((r) => {
      const s = stats.get(String(r.test_run_id)) ?? { counts: emptyCounts(), completed: 0, total: 0 };
      const snapshot = JSON.parse(String(r.config_snapshot ?? "{}")) as { browsers?: string[]; viewports?: string[] };
      return {
        runId: String(r.test_run_id),
        name: str(r.run_name),
        projectId: String(r.project_id),
        projectName: String(r.project_name),
        websiteUrl: String(r.website_url),
        sourceKind: String(r.source_kind) as ExternalExecutionRecord["sourceKind"],
        sourceName: String(r.source_name),
        worksheet: String(r.worksheet),
        outputMode: String(r.output_mode) as ExternalExecutionRecord["outputMode"],
        outputFileName: str(r.output_file_name),
        outputError: str(r.output_error),
        resultColumns: r.result_columns ? (JSON.parse(String(r.result_columns)) as ExternalExecutionRecord["resultColumns"]) : null,
        runStatus: String(r.run_status) as ExternalExecutionRecord["runStatus"],
        cancelRequested: Number(r.cancel_requested ?? 0) === 1,
        currentTest: str(r.current_test),
        browsers: snapshot.browsers ?? [],
        viewports: snapshot.viewports ?? [],
        totalCases: s.total,
        completedCases: s.completed,
        counts: s.counts,
        createdAt: String(r.created_at),
        startedAt: str(r.started_at),
        completedAt: str(r.completed_at),
        errorMessage: str(r.error_message),
      };
    });
  }

  private readonly select = `SELECT e.*, r.name AS run_name, r.status AS run_status, r.cancel_requested, r.current_test, r.config_snapshot, r.started_at, r.completed_at,
      r.error_message, p.name AS project_name
    FROM external_test_executions e JOIN test_runs r ON r.id = e.test_run_id JOIN projects p ON p.id = e.project_id`;

  async get(runId: string): Promise<ExternalExecutionRecord | null> {
    const row = this.db.prepare(`${this.select} WHERE e.test_run_id = ?`).get(runId) as Row | undefined;
    return row ? this.map([row])[0] : null;
  }

  async list(q: { projectId?: string; limit?: number; offset?: number } = {}): Promise<ExternalExecutionRecord[]> {
    const where = q.projectId ? "WHERE e.project_id = ?" : "";
    const rows = this.db
      .prepare(`${this.select} ${where} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ? OFFSET ?`)
      .all(...(q.projectId ? [q.projectId] : []), Math.min(Math.max(q.limit ?? 20, 1), 200), Math.max(q.offset ?? 0, 0)) as Row[];
    return this.map(rows);
  }

  async count(q: { projectId?: string } = {}): Promise<number> {
    const where = q.projectId ? "WHERE project_id = ?" : "";
    return Number((this.db.prepare(`SELECT COUNT(*) AS c FROM external_test_executions ${where}`).get(...(q.projectId ? [q.projectId] : [])) as Row).c);
  }

  async listCases(runId: string, q: { status?: ExternalStatus; limit?: number; offset?: number } = {}): Promise<{ rows: ExternalCaseRecord[]; total: number }> {
    const where = ["c.test_run_id = ?"];
    const params: unknown[] = [runId];
    if (q.status) {
      where.push("c.status = ?");
      params.push(q.status);
    }
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM external_test_cases c WHERE ${where.join(" AND ")}`).get(...params) as Row).c);
    const rows = this.db
      .prepare(`SELECT c.* FROM external_test_cases c WHERE ${where.join(" AND ")} ORDER BY c.row_number LIMIT ? OFFSET ?`)
      .all(...params, Math.min(Math.max(q.limit ?? 50, 1), 500), Math.max(q.offset ?? 0, 0)) as Row[];
    const ids = rows.map((r) => String(r.id));
    const obs = ids.length
      ? (this.db.prepare(`SELECT * FROM external_test_observations WHERE external_case_id IN (${ids.map(() => "?").join(",")}) ORDER BY observed_at`).all(...ids) as Row[])
      : [];
    return {
      total,
      rows: rows.map((r) => ({
        id: String(r.id),
        rowNumber: Number(r.row_number),
        caseRef: str(r.case_ref),
        title: String(r.title),
        steps: str(r.steps),
        expected: str(r.expected),
        status: str(r.status) as ExternalStatus | null,
        actual: str(r.actual_result),
        executedAt: str(r.executed_at),
        observations: obs
          .filter((o) => o.external_case_id === r.id)
          .map((o) => ({
            browser: String(o.browser),
            viewport: String(o.viewport),
            status: String(o.status) as ExternalStatus,
            actual: String(o.actual_result),
            screenshotKey: str(o.screenshot_key),
            testResultId: str(o.test_result_id),
          })),
      })),
    };
  }

  async getOutputFile(runId: string): Promise<{ storageKey: string; fileName: string } | null> {
    const row = this.db.prepare("SELECT output_storage_key, output_file_name FROM external_test_executions WHERE test_run_id = ?").get(runId) as Row | undefined;
    return row?.output_storage_key ? { storageKey: String(row.output_storage_key), fileName: String(row.output_file_name) } : null;
  }
}
