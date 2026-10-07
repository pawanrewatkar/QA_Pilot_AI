import { randomUUID } from "node:crypto";
import { DeterministicDuplicateDetector } from "@/lib/bugs/duplicates";
import { createBugsForRun } from "@/lib/bugs/engine";
import type { BugDetail, BugEvidenceRecord, BugHistoryRecord, BugOccurrenceRecord, BugQuery, BugRecord, BugStatus } from "@/types";
import type { BugFacets, BugRepository } from "../provider";
import type { SqliteDatabase } from "./sqlite-client";

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
  constructor(private readonly db: SqliteDatabase) {}

  private where(q: BugQuery) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, ...p: unknown[]) => {
      where.push(sql);
      params.push(...p);
    };
    if (q.projectId) add("b.project_id = ?", q.projectId);
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
      add(`(b.title LIKE ? ESCAPE '\\' OR b.code LIKE ? ESCAPE '\\' OR b.page_url LIKE ? ESCAPE '\\' OR b.actual_result LIKE ? ESCAPE '\\')`, p, p, p, p);
    }
    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  async list(q: BugQuery = {}): Promise<BugRecord[]> {
    const { sql, params } = this.where(q);
    const rows = this.db
      .prepare(
        `SELECT b.*, p.name AS project_name FROM bugs b JOIN projects p ON p.id = b.project_id ${sql}
         ORDER BY CASE b.status WHEN 'OPEN' THEN 0 WHEN 'REOPENED' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
           CASE b.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, b.priority, b.created_at DESC, b.rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.min(Math.max(q.limit ?? 100, 1), 1000), Math.max(q.offset ?? 0, 0)) as Row[];
    return rows.map(mapBug);
  }

  async count(q: BugQuery = {}): Promise<number> {
    const { sql, params } = this.where(q);
    return Number((this.db.prepare(`SELECT COUNT(*) AS c FROM bugs b ${sql}`).get(...params) as Row).c);
  }

  async facets(projectId?: string): Promise<BugFacets> {
    const scope = projectId ? "WHERE b.project_id = ?" : "";
    const params = projectId ? [projectId] : [];
    const pages = this.db.prepare(`SELECT DISTINCT b.page_id AS id, b.page_url AS url FROM bugs b ${scope} ${scope ? "AND" : "WHERE"} b.page_id IS NOT NULL ORDER BY b.page_url LIMIT 500`).all(...params) as Row[];
    const types = this.db.prepare(`SELECT DISTINCT b.test_type AS t FROM bugs b ${scope} ${scope ? "AND" : "WHERE"} b.test_type IS NOT NULL ORDER BY t`).all(...params) as Row[];
    const browsers = this.db
      .prepare(`SELECT DISTINCT o.browser AS b FROM bug_occurrences o JOIN bugs b ON b.id = o.bug_id ${scope} ${scope ? "AND" : "WHERE"} o.browser IS NOT NULL ORDER BY o.browser`)
      .all(...params) as Row[];
    return { pages: pages.map((p) => ({ id: String(p.id), url: String(p.url) })), testTypes: types.map((t) => String(t.t)), browsers: browsers.map((b) => String(b.b)) };
  }

  async getDetail(id: string): Promise<BugDetail | null> {
    const row = this.db.prepare("SELECT b.*, p.name AS project_name FROM bugs b JOIN projects p ON p.id = b.project_id WHERE b.id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const evidence = (this.db.prepare("SELECT * FROM bug_evidence WHERE bug_id = ? ORDER BY captured_at, rowid").all(id) as Row[]).map(
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
      this.db
        .prepare("SELECT o.*, r.name AS run_name FROM bug_occurrences o LEFT JOIN test_runs r ON r.id = o.test_run_id WHERE o.bug_id = ? ORDER BY o.observed_at DESC, o.rowid DESC")
        .all(id) as Row[]
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
    const history = (this.db.prepare("SELECT * FROM bug_status_history WHERE bug_id = ? ORDER BY changed_at, rowid").all(id) as Row[]).map(
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
    const bug = this.db.prepare("SELECT * FROM bugs WHERE id = ?").get(id) as Row | undefined;
    if (!bug) return [];
    const candidates = this.db.prepare("SELECT b.*, p.name AS project_name FROM bugs b JOIN projects p ON p.id = b.project_id WHERE b.project_id = ? AND b.id != ? AND b.page_url IS ?").all(bug.project_id, id, bug.page_url) as Row[];
    const matches = new DeterministicDuplicateDetector().find(
      { id, fingerprint: String(bug.fingerprint ?? ""), pageUrl: str(bug.page_url), testType: str(bug.test_type), selector: str(bug.selector), element: str(bug.element) },
      candidates.map((c) => ({ id: String(c.id), fingerprint: String(c.fingerprint ?? ""), pageUrl: str(c.page_url), testType: str(c.test_type), selector: str(c.selector), element: str(c.element) })),
    );
    const ids = new Set(matches.map((m) => m.bugId));
    return candidates.filter((c) => ids.has(String(c.id))).map(mapBug);
  }

  async updateStatus(id: string, status: BugStatus, note: string | null): Promise<BugRecord | null> {
    const row = this.db.prepare("SELECT status FROM bugs WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const ts = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?").run(status, ts, id);
      this.db.prepare("INSERT INTO bug_status_history (id, bug_id, from_status, to_status, note, source, changed_at) VALUES (?, ?, ?, ?, ?, 'USER', ?)").run(randomUUID(), id, row.status, status, note, ts);
    })();
    const updated = this.db.prepare("SELECT b.*, p.name AS project_name FROM bugs b JOIN projects p ON p.id = b.project_id WHERE b.id = ?").get(id) as Row;
    return mapBug(updated);
  }

  async createFromRun(runId: string) {
    const { failures, created, updated, reopened } = createBugsForRun(this.db, runId);
    return { failures, created, updated, reopened };
  }
}
