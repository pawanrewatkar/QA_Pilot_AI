import { randomUUID } from "node:crypto";
import { DeterministicDuplicateDetector } from "@/lib/bugs/duplicates";
import { createBugsForRun } from "@/lib/bugs/engine";
import type { BugDetail, BugEvidenceRecord, BugHistoryRecord, BugOccurrenceRecord, BugQuery, BugRecord, BugStatus } from "@/types";
import type { BugFacets, BugRepository } from "../provider";
import { ilike } from "../sql/dialect";
import type { SqlExecutor, SqlValue } from "../sql/executor";
import { ownedProjectIds } from "./ownership";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function mapBug(row: Row): BugRecord {
  return {
    id: String(row.id),
    code: str(row.code),
    projectId: String(row.project_id),
    projectName: String(row.project_name ?? ""),
    testRunId: str(row.test_run_id),
    title: String(row.title),
    severity: String(row.severity) as BugRecord["severity"],
    priority: (str(row.priority) ?? "P2") as BugRecord["priority"],
    status: String(row.status) as BugRecord["status"],
    pageUrl: str(row.page_url),
    pageName: str(row.page_name),
    section: str(row.section),
    testType: str(row.test_type),
    scenarioType: str(row.scenario_type),
    browser: str(row.browser),
    viewport: str(row.viewport),
    element: str(row.element),
    selector: str(row.selector),
    occurrenceCount: Number(row.occurrence_count ?? 1),
    firstSeenRunId: str(row.first_seen_run_id),
    lastSeenRunId: str(row.last_seen_run_id),
    lastSeenAt: str(row.last_seen_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class LocalBugRepository implements BugRepository {
  constructor(private readonly sql: SqlExecutor) {}

  private where(q: BugQuery) {
    const where: string[] = [];
    const params: SqlValue[] = [];
    const add = (sql: string, ...p: SqlValue[]) => {
      where.push(sql);
      params.push(...p);
    };
    if (q.projectId) add("b.project_id = ?", q.projectId);
    if (q.ownerId !== undefined) add(ownedProjectIds("b.project_id"), q.ownerId);
    if (q.testRunId) add("EXISTS (SELECT 1 FROM bug_occurrences o WHERE o.bug_id = b.id AND o.test_run_id = ?)", q.testRunId);
    if (q.severity) add("b.severity = ?", q.severity);
    if (q.priority) add("b.priority = ?", q.priority);
    if (q.status) add("b.status = ?", q.status);
    if (q.pageId) add("b.page_id = ?", q.pageId);
    if (q.testType) add("b.test_type = ?", q.testType);
    if (q.browser) add("EXISTS (SELECT 1 FROM bug_occurrences o WHERE o.bug_id = b.id AND o.browser = ?)", q.browser);
    if (q.device) add("EXISTS (SELECT 1 FROM bug_occurrences o WHERE o.bug_id = b.id AND o.viewport LIKE ?)", `${q.device}-%`);
    const search = q.search?.trim();
    if (search) {
      const p = likePattern(search);
      const like = ilike(this.sql);
      add(`(b.title ${like} ? ESCAPE '\\' OR b.code ${like} ? ESCAPE '\\' OR b.page_url ${like} ? ESCAPE '\\' OR b.actual_result ${like} ? ESCAPE '\\')`, p, p, p, p);
    }
    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  async list(q: BugQuery = {}): Promise<BugRecord[]> {
    const { sql, params } = this.where(q);
    // SQLite sorts NULL priorities first; PostgreSQL needs NULLS FIRST for the same order.
    const nulls = this.sql.dialect === "postgres" ? " NULLS FIRST" : "";
    const rows = await this.sql.all<Row>(
      `SELECT b.*, p.name AS project_name FROM bugs b JOIN projects p ON p.id = b.project_id ${sql}
         ORDER BY CASE b.status WHEN 'OPEN' THEN 0 WHEN 'REOPENED' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
           CASE b.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, b.priority${nulls}, b.created_at DESC, b.rowid DESC
         LIMIT ? OFFSET ?`,
      [...params, Math.min(Math.max(q.limit ?? 100, 1), 1000), Math.max(q.offset ?? 0, 0)],
    );
    return rows.map(mapBug);
  }

  async count(q: BugQuery = {}): Promise<number> {
    const { sql, params } = this.where(q);
    return Number(((await this.sql.get<Row>(`SELECT COUNT(*) AS c FROM bugs b ${sql}`, params)) as Row).c);
  }

  async facets(projectId?: string, ownerId?: string): Promise<BugFacets> {
    const conditions = [...(projectId ? ["b.project_id = ?"] : []), ...(ownerId !== undefined ? [ownedProjectIds("b.project_id")] : [])];
    const scope = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const params: SqlValue[] = [...(projectId ? [projectId] : []), ...(ownerId !== undefined ? [ownerId] : [])];
    const pages = await this.sql.all<Row>(`SELECT DISTINCT b.page_id AS id, b.page_url AS url FROM bugs b ${scope} ${scope ? "AND" : "WHERE"} b.page_id IS NOT NULL ORDER BY b.page_url LIMIT 500`, params);
    const types = await this.sql.all<Row>(`SELECT DISTINCT b.test_type AS t FROM bugs b ${scope} ${scope ? "AND" : "WHERE"} b.test_type IS NOT NULL ORDER BY t`, params);
    const browsers = await this.sql.all<Row>(
      `SELECT DISTINCT o.browser AS b FROM bug_occurrences o JOIN bugs b ON b.id = o.bug_id ${scope} ${scope ? "AND" : "WHERE"} o.browser IS NOT NULL ORDER BY o.browser`,
      params,
    );
    return { pages: pages.map((p) => ({ id: String(p.id), url: String(p.url) })), testTypes: types.map((t) => String(t.t)), browsers: browsers.map((b) => String(b.b)) };
  }

  async getDetail(id: string): Promise<BugDetail | null> {
    const row = await this.sql.get<Row>("SELECT b.*, p.name AS project_name FROM bugs b JOIN projects p ON p.id = b.project_id WHERE b.id = ?", [id]);
    if (!row) return null;
    const evidence = (await this.sql.all<Row>("SELECT * FROM bug_evidence WHERE bug_id = ? ORDER BY captured_at, rowid", [id])).map(
      (e): BugEvidenceRecord => ({
        id: String(e.id),
        type: String(e.evidence_type) as BugEvidenceRecord["type"],
        label: str(e.label),
        screenshotKind: str(e.screenshot_kind) as BugEvidenceRecord["screenshotKind"],
        storageKey: str(e.storage_key),
        content: str(e.content),
        testRunId: str(e.test_run_id),
        testResultId: str(e.test_result_id),
        url: str(e.url),
        browser: str(e.browser),
        viewport: str(e.viewport),
        selector: str(e.selector),
        capturedAt: str(e.captured_at),
      }),
    );
    const occurrences = (
      await this.sql.all<Row>("SELECT o.*, r.name AS run_name FROM bug_occurrences o LEFT JOIN test_runs r ON r.id = o.test_run_id WHERE o.bug_id = ? ORDER BY o.observed_at DESC, o.rowid DESC", [id])
    ).map(
      (o): BugOccurrenceRecord => ({
        id: String(o.id),
        testRunId: String(o.test_run_id),
        testRunName: str(o.run_name),
        testResultId: str(o.test_result_id),
        browser: str(o.browser),
        viewport: str(o.viewport),
        actualResult: str(o.actual_result),
        observedAt: String(o.observed_at),
      }),
    );
    const history = (await this.sql.all<Row>("SELECT * FROM bug_status_history WHERE bug_id = ? ORDER BY changed_at, rowid", [id])).map(
      (h): BugHistoryRecord => ({
        id: String(h.id),
        fromStatus: str(h.from_status) as BugStatus | null,
        toStatus: String(h.to_status) as BugStatus,
        note: str(h.note),
        source: String(h.source) as BugHistoryRecord["source"],
        changedAt: String(h.changed_at),
      }),
    );
    return {
      ...mapBug(row),
      description: str(row.description),
      severityReason: str(row.severity_reason),
      expectedResult: str(row.expected_result),
      actualResult: str(row.actual_result),
      stepsToReproduce: str(row.steps_to_reproduce),
      technicalDetails: str(row.technical_details),
      screenshotKey: str(row.screenshot_key),
      testCaseId: str(row.test_case_id),
      testResultId: str(row.test_result_id),
      evidence,
      occurrences,
      history,
    };
  }

  async related(id: string): Promise<BugRecord[]> {
    const bug = await this.sql.get<Row>("SELECT * FROM bugs WHERE id = ?", [id]);
    if (!bug) return [];
    const candidates = await this.sql.all<Row>(
      "SELECT b.*, p.name AS project_name FROM bugs b JOIN projects p ON p.id = b.project_id WHERE b.project_id = ? AND b.id != ? AND b.page_url IS NOT DISTINCT FROM ?",
      [bug.project_id as SqlValue, id, bug.page_url as SqlValue],
    );
    const matches = new DeterministicDuplicateDetector().find(
      { id, fingerprint: String(bug.fingerprint ?? ""), pageUrl: str(bug.page_url), testType: str(bug.test_type), selector: str(bug.selector), element: str(bug.element) },
      candidates.map((c) => ({ id: String(c.id), fingerprint: String(c.fingerprint ?? ""), pageUrl: str(c.page_url), testType: str(c.test_type), selector: str(c.selector), element: str(c.element) })),
    );
    const ids = new Set(matches.map((m) => m.bugId));
    return candidates.filter((c) => ids.has(String(c.id))).map(mapBug);
  }

  async updateStatus(id: string, status: BugStatus, note: string | null): Promise<BugRecord | null> {
    const row = await this.sql.get<Row>("SELECT status FROM bugs WHERE id = ?", [id]);
    if (!row) return null;
    const ts = new Date().toISOString();
    await this.sql.transaction(async (tx) => {
      await tx.run("UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?", [status, ts, id]);
      await tx.run("INSERT INTO bug_status_history (id, bug_id, from_status, to_status, note, source, changed_at) VALUES (?, ?, ?, ?, ?, 'USER', ?)", [randomUUID(), id, row.status as SqlValue, status, note, ts]);
    });
    const updated = (await this.sql.get<Row>("SELECT b.*, p.name AS project_name FROM bugs b JOIN projects p ON p.id = b.project_id WHERE b.id = ?", [id])) as Row;
    return mapBug(updated);
  }

  async createFromRun(runId: string) {
    const { failures, created, updated, reopened } = await createBugsForRun(this.sql, runId);
    return { failures, created, updated, reopened };
  }
}
