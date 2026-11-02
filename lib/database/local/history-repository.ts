import {
  compareFindingSets,
  comparePerformance,
  compareResults,
  countCategories,
  type KeyedResult,
  type PerfPoint,
  type RunComparison,
} from "@/lib/regression/compare";
import type { BugSeverity, HistoryQuery, RunHistoryRecord, TestResultStatus } from "@/types";
import type { HistoryRepository } from "../provider";
import { ilike } from "../sql/dialect";
import type { SqlExecutor, SqlValue } from "../sql/executor";
import { mapBug } from "./bug-repository";
import { countsFor } from "./engine-repositories";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const FINISHED = "('COMPLETED','FAILED','CANCELLED')";

const RUN_SELECT = `SELECT r.*, p.name AS project_name, p.website_url,
  (SELECT COUNT(*) FROM test_run_pages x WHERE x.test_run_id = r.id) AS page_count,
  (SELECT COUNT(DISTINCT o.bug_id) FROM bug_occurrences o WHERE o.test_run_id = r.id) AS bug_count,
  (SELECT COUNT(*) FROM bugs b WHERE b.first_seen_run_id = r.id) AS new_bug_count,
  (SELECT AVG(x.performance_score) FROM performance_results x WHERE x.test_run_id = r.id AND x.performance_score IS NOT NULL) AS perf_score,
  (SELECT AVG(x.lcp_ms) FROM performance_results x WHERE x.test_run_id = r.id AND x.lcp_ms IS NOT NULL) AS lcp
  FROM test_runs r JOIN projects p ON p.id = r.project_id`;

export class LocalHistoryRepository implements HistoryRepository {
  constructor(private readonly sql: SqlExecutor) {}

  private where(q: HistoryQuery) {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (q.projectId) {
      where.push("r.project_id = ?");
      params.push(q.projectId);
    }
    if (q.ownerId !== undefined) {
      where.push("p.owner_id = ?");
      params.push(q.ownerId);
    }
    if (q.status) {
      where.push("r.status = ?");
      params.push(q.status);
    }
    const search = q.search?.trim();
    if (search) {
      const p = likePattern(search);
      // SQLite's LIKE ignores case (ASCII letters); PostgreSQL's does not, so it uses ILIKE (Phase 3.3a).
      const like = ilike(this.sql);
      where.push(`(r.name ${like} ? ESCAPE '\\' OR p.name ${like} ? ESCAPE '\\' OR p.website_url ${like} ? ESCAPE '\\')`);
      params.push(p, p, p);
    }
    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  private async moduleRatio(runId: string, module: string): Promise<{ failed: number; executed: number } | null> {
    const row = (await this.sql.get<Row>(
      `SELECT SUM(CASE WHEN tr.status = 'FAIL' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN tr.status IN ('PASS','FAIL','WARNING') THEN 1 ELSE 0 END) AS executed
         FROM test_results tr JOIN test_cases tc ON tc.id = tr.test_case_id WHERE tr.test_run_id = ? AND tc.module = ?`,
      [runId, module],
    )) as Row;
    const executed = Number(row.executed ?? 0);
    return executed ? { failed: Number(row.failed ?? 0), executed } : null;
  }

  private async map(rows: Row[]): Promise<RunHistoryRecord[]> {
    const counts = await countsFor(this.sql, rows.map((r) => String(r.id)));
    const out: RunHistoryRecord[] = [];
    for (const r of rows) {
      const id = String(r.id);
      const severity: Record<BugSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
      const severities = await this.sql.all<Row>(
        "SELECT b.severity, COUNT(DISTINCT b.id) AS c FROM bug_occurrences o JOIN bugs b ON b.id = o.bug_id WHERE o.test_run_id = ? GROUP BY b.severity",
        [id],
      );
      for (const s of severities) severity[String(s.severity) as BugSeverity] = Number(s.c);
      const c = counts[id];
      out.push({
        id,
        name: str(r.name),
        runType: String(r.run_type ?? "WEBSITE") as RunHistoryRecord["runType"],
        projectId: String(r.project_id),
        projectName: String(r.project_name),
        website: String(r.website_url),
        status: String(r.status) as RunHistoryRecord["status"],
        createdAt: String(r.created_at),
        completedAt: str(r.completed_at),
        pages: Number(r.page_count ?? 0),
        totalTests: c.PASS + c.FAIL + c.WARNING + c["NOT EXECUTED"] + c["NOT APPLICABLE"],
        counts: c,
        bugs: Number(r.bug_count ?? 0),
        newBugs: Number(r.new_bug_count ?? 0),
        severity,
        performanceScore: numOrNull(r.perf_score),
        lcpMs: numOrNull(r.lcp),
        accessibility: await this.moduleRatio(id, "accessibility"),
        seo: await this.moduleRatio(id, "seo"),
      });
    }
    return out;
  }

  async listRuns(q: HistoryQuery = {}): Promise<RunHistoryRecord[]> {
    const { sql, params } = this.where(q);
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 200);
    // `r.rowid`: insertion order for equal timestamps (an identity column in the PostgreSQL schema).
    const rows = await this.sql.all<Row>(`${RUN_SELECT} ${sql} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?`, [...params, limit, Math.max(0, q.offset ?? 0)]);
    return this.map(rows);
  }

  async countRuns(q: HistoryQuery = {}): Promise<number> {
    const { sql, params } = this.where(q);
    const row = (await this.sql.get<Row>(`SELECT COUNT(*) AS c FROM test_runs r JOIN projects p ON p.id = r.project_id ${sql}`, params)) as Row;
    return Number(row.c);
  }

  async getRun(id: string): Promise<RunHistoryRecord | null> {
    const row = await this.sql.get<Row>(`${RUN_SELECT} WHERE r.id = ?`, [id]);
    return row ? (await this.map([row]))[0] : null;
  }

  async previousRunId(runId: string): Promise<string | null> {
    const run = await this.sql.get<Row>("SELECT project_id, created_at FROM test_runs WHERE id = ?", [runId]);
    if (!run) return null;
    const prev = await this.sql.get<Row>(
      `SELECT id FROM test_runs WHERE project_id = ? AND id != ? AND status IN ${FINISHED} AND created_at < ?
         ORDER BY CASE status WHEN 'COMPLETED' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1`,
      [run.project_id as SqlValue, runId, run.created_at as SqlValue],
    );
    return prev ? String(prev.id) : null;
  }

  async comparableRuns(runId: string): Promise<{ id: string; name: string | null; status: string; createdAt: string }[]> {
    const run = await this.sql.get<Row>("SELECT project_id FROM test_runs WHERE id = ?", [runId]);
    if (!run) return [];
    // No tie-break: the order of runs sharing a created_at is not defined.
    return (
      await this.sql.all<Row>(`SELECT id, name, status, created_at FROM test_runs WHERE project_id = ? AND id != ? AND status IN ${FINISHED} ORDER BY created_at DESC LIMIT 100`, [
        run.project_id as SqlValue,
        runId,
      ])
    ).map((r) => ({ id: String(r.id), name: str(r.name), status: String(r.status), createdAt: String(r.created_at) }));
  }

  private async keyedResults(runId: string): Promise<KeyedResult[]> {
    return (
      await this.sql.all<Row>(
        `SELECT tc.case_key, tc.title, tc.module, tr.browser, tr.viewport, tr.status, COALESCE(tr.url, tc.page_url) AS url
           FROM test_results tr JOIN test_cases tc ON tc.id = tr.test_case_id WHERE tr.test_run_id = ? AND tc.case_key IS NOT NULL`,
        [runId],
      )
    ).map((r) => ({
      caseKey: String(r.case_key),
      title: String(r.title),
      module: String(r.module),
      browser: str(r.browser),
      viewport: str(r.viewport),
      status: String(r.status) as TestResultStatus,
      pageUrl: str(r.url),
    }));
  }

  private async perfPoints(runId: string): Promise<PerfPoint[]> {
    // Latest measurement per page and form factor.
    const rows = await this.sql.all<Row>(
      `SELECT pg.url AS page_url, x.form_factor, x.source, x.performance_score, x.accessibility_score, x.lcp_ms, x.cls, x.tbt_ms
         FROM performance_results x JOIN pages pg ON pg.id = x.page_id WHERE x.test_run_id = ? ORDER BY x.measured_at`,
      [runId],
    );
    const latest = new Map<string, PerfPoint>();
    for (const r of rows) {
      latest.set(`${r.page_url}|${r.form_factor ?? ""}`, {
        pageUrl: String(r.page_url),
        formFactor: str(r.form_factor),
        source: String(r.source),
        performanceScore: numOrNull(r.performance_score),
        accessibilityScore: numOrNull(r.accessibility_score),
        lcpMs: numOrNull(r.lcp_ms),
        cls: numOrNull(r.cls),
        tbtMs: numOrNull(r.tbt_ms),
      });
    }
    return [...latest.values()];
  }

  /** Findings per page/browser/viewport scope, plus the scopes where the module actually executed. */
  private async findingSets(runId: string, modules: string[], findingsSql: string) {
    const examined = new Set(
      (
        await this.sql.all<Row>(
          `SELECT DISTINCT COALESCE(tr.url, tc.page_url) AS url, tr.browser, tr.viewport FROM test_results tr JOIN test_cases tc ON tc.id = tr.test_case_id
             WHERE tr.test_run_id = ? AND tc.module IN (${modules.map(() => "?").join(",")}) AND tr.status IN ('PASS','FAIL','WARNING')`,
          [runId, ...modules],
        )
      ).map((r) => `${r.url} · ${r.browser ?? "?"} · ${r.viewport ?? "?"}`),
    );
    const findings = new Map<string, Set<string>>();
    for (const r of await this.sql.all<Row>(findingsSql, [runId])) {
      const scope = `${r.url} · ${r.browser ?? "?"} · ${r.viewport ?? "?"}`;
      const set = findings.get(scope) ?? new Set<string>();
      set.add(String(r.finding));
      findings.set(scope, set);
    }
    return { examined, findings };
  }

  async compare(currentId: string, previousId: string): Promise<RunComparison | null> {
    const current = await this.getRun(currentId);
    const previous = await this.getRun(previousId);
    if (!current || !previous || current.projectId !== previous.projectId || currentId === previousId) return null;

    const results = compareResults(await this.keyedResults(previousId), await this.keyedResults(currentId));

    const bugSelect = "SELECT b.*, p.name AS project_name FROM bugs b JOIN projects p ON p.id = b.project_id";
    const inRun = "EXISTS (SELECT 1 FROM bug_occurrences o WHERE o.bug_id = b.id AND o.test_run_id = ?)";
    // SQLite sorts NULL codes first; PostgreSQL needs NULLS FIRST for the same order.
    const byCode = `ORDER BY b.code${this.sql.dialect === "postgres" ? " NULLS FIRST" : ""}`;
    const newBugs = (await this.sql.all<Row>(`${bugSelect} WHERE ${inRun} AND b.first_seen_run_id = ? ${byCode}`, [currentId, currentId])).map(mapBug);
    const existingBugs = (await this.sql.all<Row>(`${bugSelect} WHERE ${inRun} AND (b.first_seen_run_id IS NULL OR b.first_seen_run_id != ?) ${byCode}`, [currentId, currentId])).map(mapBug);
    // Bugs seen before but not in this run stay open: absence of a failure is not proof of a fix.
    const notObserved = (await this.sql.all<Row>(`${bugSelect} WHERE ${inRun} AND NOT ${inRun} ${byCode}`, [previousId, currentId])).map(mapBug);

    const a11ySql = `SELECT pg.url, COALESCE(d.browser, tr.browser) AS browser, COALESCE(d.viewport, tr.viewport) AS viewport, d.rule_id AS finding
      FROM accessibility_results d JOIN pages pg ON pg.id = d.page_id LEFT JOIN test_results tr ON tr.id = d.test_result_id
      WHERE d.test_run_id = ? AND d.status IN ('FAIL','WARNING')`;
    const uiSql = `SELECT pg.url, COALESCE(d.browser, tr.browser) AS browser, COALESCE(d.viewport, tr.viewport) AS viewport,
        d.check_key || CASE WHEN d.selector IS NOT NULL THEN ' @ ' || d.selector ELSE '' END AS finding
      FROM ui_results d JOIN pages pg ON pg.id = d.page_id LEFT JOIN test_results tr ON tr.id = d.test_result_id
      WHERE d.test_run_id = ? AND d.status IN ('FAIL','WARNING')`;
    const a11yPrev = await this.findingSets(previousId, ["accessibility"], a11ySql);
    const a11yCurr = await this.findingSets(currentId, ["accessibility"], a11ySql);
    const uiPrev = await this.findingSets(previousId, ["ui", "responsive"], uiSql);
    const uiCurr = await this.findingSets(currentId, ["ui", "responsive"], uiSql);

    return {
      current,
      previous,
      results,
      counts: countCategories(results),
      bugs: { new: newBugs, existing: existingBugs, notObserved },
      performance: comparePerformance(await this.perfPoints(previousId), await this.perfPoints(currentId)),
      accessibility: compareFindingSets(a11yPrev.findings, a11yCurr.findings, a11yPrev.examined, a11yCurr.examined),
      ui: compareFindingSets(uiPrev.findings, uiCurr.findings, uiPrev.examined, uiCurr.examined),
    };
  }
}
