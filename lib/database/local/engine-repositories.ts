import { randomUUID } from "node:crypto";
import type {
  CrawlConfig,
  CrawlRun,
  ListOptions,
  PageRecord,
  ResultStatusCounts,
  TestCaseRecord,
  TestResultRecord,
  TestRun,
  TestRunDetail,
  WorkerStatus,
} from "@/types";
import { getDetailView } from "@/lib/constants/detail-views";
import type {
  CrawlRunRepository,
  DetailFilters,
  DetailRowRecord,
  NewTestRun,
  PageQuery,
  PageRepository,
  TestCaseRepository,
  TestResultQuery,
  TestResultRepository,
  WorkerRepository,
} from "../provider";
import type { SqliteDatabase } from "./sqlite-client";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const clampLimit = (limit?: number, max = 1000) => (!limit || limit < 1 ? 100 : Math.min(Math.floor(limit), max));
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const emptyCounts = (): ResultStatusCounts => ({ PASS: 0, FAIL: 0, WARNING: 0, "NOT EXECUTED": 0, "NOT APPLICABLE": 0 });

/** Enqueues a worker job; must run inside the caller's transaction. */
export function enqueueJob(db: SqliteDatabase, type: string, payload: unknown) {
  const ts = now();
  db.prepare("INSERT INTO jobs (id, type, payload, status, max_attempts, run_after, created_at, updated_at) VALUES (?, ?, ?, 'PENDING', 1, ?, ?, ?)").run(
    randomUUID(),
    type,
    JSON.stringify(payload),
    ts,
    ts,
    ts,
  );
}

// ---------------------------------------------------------------- pages

export function mapPage(row: Row): PageRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectName: String(row.project_name ?? ""),
    url: String(row.url),
    title: str(row.title),
    httpStatus: numOrNull(row.http_status),
    discoveredVia: str(row.discovered_via),
    depth: numOrNull(row.depth),
    lastSeenAt: String(row.last_seen_at),
    name: str(row.name),
    description: str(row.description),
    pageType: (str(row.page_type) ?? "OTHER") as PageRecord["pageType"],
    pageTypeConfidence: numOrNull(row.page_type_confidence),
    crawlStatus: (str(row.crawl_status) ?? "DISCOVERED") as PageRecord["crawlStatus"],
    discoverySources: json(row.discovery_sources, []),
    isSelected: Number(row.is_selected ?? 1) === 1,
    finalUrl: str(row.final_url),
    errorMessage: str(row.error_message),
  };
}

export class LocalPageRepository implements PageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private where(q: PageQuery): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.projectId) {
      where.push("pg.project_id = ?");
      params.push(q.projectId);
    }
    if (q.pageType) {
      where.push("pg.page_type = ?");
      params.push(q.pageType);
    }
    if (q.crawlStatus) {
      where.push("pg.crawl_status = ?");
      params.push(q.crawlStatus);
    }
    if (q.selectedOnly) where.push("pg.is_selected = 1");
    const search = q.search?.trim();
    if (search) {
      const p = likePattern(search);
      where.push(`(pg.url LIKE ? ESCAPE '\\' OR pg.title LIKE ? ESCAPE '\\' OR pg.name LIKE ? ESCAPE '\\')`);
      params.push(p, p, p);
    }
    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  async list(q: PageQuery = {}): Promise<PageRecord[]> {
    const { sql, params } = this.where(q);
    const rows = this.db
      .prepare(
        `SELECT pg.*, p.name AS project_name FROM pages pg JOIN projects p ON p.id = pg.project_id ${sql}
         ORDER BY COALESCE(pg.depth, 99) ASC, pg.url ASC LIMIT ?`,
      )
      .all(...params, clampLimit(q.limit, 5000)) as Row[];
    return rows.map(mapPage);
  }

  async count(q: PageQuery = {}): Promise<number> {
    const { sql, params } = this.where(q);
    return Number((this.db.prepare(`SELECT COUNT(*) AS c FROM pages pg ${sql}`).get(...params) as Row).c);
  }

  async getByIds(projectId: string, ids: string[]): Promise<PageRecord[]> {
    if (!ids.length) return [];
    const out: PageRecord[] = [];
    const stmt = this.db.prepare("SELECT pg.*, p.name AS project_name FROM pages pg JOIN projects p ON p.id = pg.project_id WHERE pg.project_id = ? AND pg.id = ?");
    for (const id of ids) {
      const row = stmt.get(projectId, id) as Row | undefined;
      if (row) out.push(mapPage(row));
    }
    return out;
  }

  async setSelected(projectId: string, ids: string[], selected: boolean): Promise<number> {
    const stmt = this.db.prepare("UPDATE pages SET is_selected = ? WHERE project_id = ? AND id = ?");
    let changed = 0;
    this.db.transaction(() => {
      for (const id of ids) changed += stmt.run(selected ? 1 : 0, projectId, id).changes;
    })();
    return changed;
  }

  async addManual(projectId: string, url: string, normalizedUrl: string): Promise<{ page: PageRecord; created: boolean }> {
    const existing = this.db.prepare("SELECT id, discovery_sources FROM pages WHERE project_id = ? AND normalized_url = ?").get(projectId, normalizedUrl) as Row | undefined;
    let id: string;
    let created = false;
    if (existing) {
      id = String(existing.id);
      const sources = [...new Set([...json<string[]>(existing.discovery_sources, []), "manual"])];
      this.db.prepare("UPDATE pages SET discovery_sources = ?, is_selected = 1 WHERE id = ?").run(JSON.stringify(sources), id);
    } else {
      id = randomUUID();
      created = true;
      const ts = now();
      let name = "Manual page";
      try {
        name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "Home").replace(/[-_]+/g, " ") || "Home";
      } catch {
        /* keep default */
      }
      this.db
        .prepare(
          `INSERT INTO pages (id, project_id, url, normalized_url, name, discovered_via, depth, page_type, crawl_status, discovery_sources, is_selected, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, 'MANUAL', NULL, 'OTHER', 'DISCOVERED', '["manual"]', 1, ?, ?)`,
        )
        .run(id, projectId, url, normalizedUrl, name, ts, ts);
    }
    const row = this.db.prepare("SELECT pg.*, p.name AS project_name FROM pages pg JOIN projects p ON p.id = pg.project_id WHERE pg.id = ?").get(id) as Row;
    return { page: mapPage(row), created };
  }

  async remove(projectId: string, ids: string[]): Promise<number> {
    const stmt = this.db.prepare("DELETE FROM pages WHERE project_id = ? AND id = ?");
    let removed = 0;
    this.db.transaction(() => {
      for (const id of ids) removed += stmt.run(projectId, id).changes;
    })();
    return removed;
  }
}

// ---------------------------------------------------------------- crawl runs

function mapCrawlRun(row: Row): CrawlRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    status: String(row.status) as CrawlRun["status"],
    config: json<CrawlConfig>(row.config, {} as CrawlConfig),
    startUrl: String(row.start_url),
    resolvedStartUrl: str(row.resolved_start_url),
    pagesDiscovered: Number(row.pages_discovered),
    pagesCrawled: Number(row.pages_crawled),
    pagesFailed: Number(row.pages_failed),
    pagesSkipped: Number(row.pages_skipped),
    currentUrl: str(row.current_url),
    currentDepth: Number(row.current_depth),
    maxDepthReached: Number(row.max_depth_reached),
    cancelRequested: Number(row.cancel_requested) === 1,
    errorMessage: str(row.error_message),
    startedAt: str(row.started_at),
    completedAt: str(row.completed_at),
    createdAt: String(row.created_at),
  };
}

export class LocalCrawlRunRepository implements CrawlRunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async createAndEnqueue(projectId: string, startUrl: string, config: CrawlConfig): Promise<CrawlRun> {
    const id = randomUUID();
    const ts = now();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO crawl_runs (id, project_id, status, config, start_url, created_at, updated_at) VALUES (?, ?, 'PENDING', ?, ?, ?, ?)")
        .run(id, projectId, JSON.stringify(config), startUrl, ts, ts);
      enqueueJob(this.db, "crawl.project", { crawlRunId: id });
    })();
    return (await this.getById(id))!;
  }

  async getById(id: string): Promise<CrawlRun | null> {
    const row = this.db.prepare("SELECT * FROM crawl_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? mapCrawlRun(row) : null;
  }

  async latest(projectId: string): Promise<CrawlRun | null> {
    const row = this.db.prepare("SELECT * FROM crawl_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(projectId) as Row | undefined;
    return row ? mapCrawlRun(row) : null;
  }

  async list(projectId: string, limit = 20): Promise<CrawlRun[]> {
    return (this.db.prepare("SELECT * FROM crawl_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(projectId, clampLimit(limit)) as Row[]).map(mapCrawlRun);
  }

  async requestCancel(id: string): Promise<boolean> {
    const ts = now();
    let changed = false;
    this.db.transaction(() => {
      const pending = this.db.prepare("UPDATE crawl_runs SET status = 'CANCELLED', cancel_requested = 1, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'").run(ts, ts, id);
      if (pending.changes) {
        this.db.prepare("UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE status = 'PENDING' AND type = 'crawl.project' AND json_extract(payload, '$.crawlRunId') = ?").run(ts, id);
        changed = true;
        return;
      }
      changed = this.db.prepare("UPDATE crawl_runs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'RUNNING'").run(ts, id).changes > 0;
    })();
    return changed;
  }
}

// ---------------------------------------------------------------- test runs (write + detail)

export function countsFor(db: SqliteDatabase, runIds: string[]): Record<string, ResultStatusCounts> {
  const out: Record<string, ResultStatusCounts> = {};
  for (const id of runIds) out[id] = emptyCounts();
  if (!runIds.length) return out;
  const stmt = db.prepare("SELECT status, COUNT(*) AS c FROM test_results WHERE test_run_id = ? GROUP BY status");
  for (const id of runIds) {
    for (const row of stmt.all(id) as Row[]) out[id][String(row.status) as keyof ResultStatusCounts] = Number(row.c);
  }
  return out;
}

export function createRunAndEnqueue(db: SqliteDatabase, input: NewTestRun): string {
  const id = randomUUID();
  const ts = now();
  const snapshot = {
    configurationName: input.configurationName,
    modules: input.modules,
    browsers: input.browsers,
    viewports: input.viewports,
    pageIds: input.pageIds,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO test_runs (id, project_id, configuration_id, status, config_snapshot, name, options, progress_total, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.projectId, input.configurationId, JSON.stringify(snapshot), input.name, JSON.stringify(input.options), input.pageIds.length * input.browsers.length * input.viewports.length, ts, ts);
    enqueueJob(db, "run.execute", { testRunId: id });
  })();
  return id;
}

export function cancelRun(db: SqliteDatabase, id: string): boolean {
  const ts = now();
  let changed = false;
  db.transaction(() => {
    const pending = db.prepare("UPDATE test_runs SET status = 'CANCELLED', cancel_requested = 1, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'").run(ts, ts, id);
    if (pending.changes) {
      db.prepare("UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE status = 'PENDING' AND type = 'run.execute' AND json_extract(payload, '$.testRunId') = ?").run(ts, id);
      changed = true;
      return;
    }
    changed = db.prepare("UPDATE test_runs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'RUNNING'").run(ts, id).changes > 0;
  })();
  return changed;
}

export function runDetail(db: SqliteDatabase, id: string): TestRunDetail | null {
  const row = db.prepare("SELECT r.*, p.name AS project_name FROM test_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const snapshot = json<{ modules?: string[]; browsers?: TestRunDetail["browsers"]; viewports?: string[]; pageIds?: string[] }>(row.config_snapshot, {});
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectName: String(row.project_name),
    name: str(row.name),
    status: String(row.status) as TestRunDetail["status"],
    configurationId: str(row.configuration_id),
    modules: snapshot.modules ?? [],
    browsers: snapshot.browsers ?? [],
    viewports: snapshot.viewports ?? [],
    pageIds: snapshot.pageIds ?? [],
    options: json(row.options, { allowFormSubmission: false, maxLinksPerPage: 100, navigationTimeoutMs: 30_000 }),
    progressTotal: Number(row.progress_total ?? 0),
    progressCompleted: Number(row.progress_completed ?? 0),
    currentPageUrl: str(row.current_page_url),
    currentTest: str(row.current_test),
    cancelRequested: Number(row.cancel_requested ?? 0) === 1,
    errorMessage: str(row.error_message),
    startedAt: str(row.started_at),
    completedAt: str(row.completed_at),
    createdAt: String(row.created_at),
    counts: countsFor(db, [id])[id],
  };
}

export function mapRunSummary(row: Row): TestRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectName: String(row.project_name),
    configurationId: str(row.configuration_id),
    status: String(row.status) as TestRun["status"],
    startedAt: str(row.started_at),
    completedAt: str(row.completed_at),
    errorMessage: str(row.error_message),
    createdAt: String(row.created_at),
  };
}

// ---------------------------------------------------------------- results & cases

export class LocalTestResultRepository implements TestResultRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private where(runId: string, q: TestResultQuery) {
    const where = ["tr.test_run_id = ?"];
    const params: unknown[] = [runId];
    if (q.status) {
      where.push("tr.status = ?");
      params.push(q.status);
    }
    if (q.module) {
      where.push("tc.module = ?");
      params.push(q.module);
    }
    if (q.browser) {
      where.push("tr.browser = ?");
      params.push(q.browser);
    }
    if (q.viewport) {
      where.push("tr.viewport = ?");
      params.push(q.viewport);
    }
    if (q.pageId) {
      where.push("tr.page_id = ?");
      params.push(q.pageId);
    }
    return { sql: `WHERE ${where.join(" AND ")}`, params };
  }

  async listByRun(runId: string, q: TestResultQuery = {}): Promise<TestResultRecord[]> {
    const { sql, params } = this.where(runId, q);
    const rows = this.db
      .prepare(
        `SELECT tr.*, tc.code, tc.module, tc.section, tc.scenario_type, tc.feature, tc.element, tc.title, tc.preconditions, tc.test_data, tc.expectation_source,
           tc.steps, tc.expected_result
         FROM test_results tr JOIN test_cases tc ON tc.id = tr.test_case_id ${sql}
         ORDER BY CASE tr.status WHEN 'FAIL' THEN 0 WHEN 'WARNING' THEN 1 WHEN 'PASS' THEN 2 WHEN 'NOT EXECUTED' THEN 3 ELSE 4 END,
           tc.code ASC, tr.browser, tr.viewport LIMIT ? OFFSET ?`,
      )
      .all(...params, clampLimit(q.limit, 2000), Math.max(0, q.offset ?? 0)) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      testRunId: String(r.test_run_id),
      testCaseId: String(r.test_case_id),
      caseCode: str(r.code),
      pageId: str(r.page_id),
      url: str(r.url),
      module: String(r.module),
      section: str(r.section),
      scenarioType: str(r.scenario_type) as TestResultRecord["scenarioType"],
      feature: str(r.feature),
      element: str(r.element),
      title: String(r.title),
      expectationSource: (str(r.expectation_source) ?? "DETECTED_FUNCTIONALITY") as TestResultRecord["expectationSource"],
      preconditions: str(r.preconditions),
      testData: str(r.test_data),
      steps: json(r.steps, []),
      expectedResult: str(r.expected_result),
      actualResult: str(r.actual_result),
      status: String(r.status) as TestResultRecord["status"],
      message: str(r.message),
      browser: str(r.browser) as TestResultRecord["browser"],
      viewport: str(r.viewport),
      evidence: json(r.evidence, []),
      verifications: json(r.verifications, []),
      durationMs: numOrNull(r.duration_ms),
      executedAt: str(r.executed_at),
    }));
  }

  async countByRun(runId: string, q: TestResultQuery = {}): Promise<number> {
    const { sql, params } = this.where(runId, q);
    return Number((this.db.prepare(`SELECT COUNT(*) AS c FROM test_results tr JOIN test_cases tc ON tc.id = tr.test_case_id ${sql}`).get(...params) as Row).c);
  }

  async isKnownArtifact(storageKey: string): Promise<boolean> {
    return !!this.db.prepare("SELECT 1 FROM screenshots WHERE storage_key = ? LIMIT 1").get(storageKey);
  }

  async listDetails(runId: string, viewId: string, filters: DetailFilters = {}): Promise<{ rows: DetailRowRecord[]; total: number }> {
    const view = getDetailView(viewId);
    if (!view) return { rows: [], total: 0 };
    const cols = (this.db.prepare(`PRAGMA table_info(${view.table})`).all() as { name: string }[]).map((c) => c.name);
    const where = ["d.test_run_id = ?"];
    const params: unknown[] = [runId];
    // Browser/viewport come from the detail row when it has them, otherwise from the linked result.
    const browserExpr = cols.includes("browser") ? "COALESCE(d.browser, tr.browser)" : "tr.browser";
    const viewportExpr = cols.includes("viewport") ? "COALESCE(d.viewport, tr.viewport)" : "tr.viewport";
    if (filters.pageId) {
      where.push("d.page_id = ?");
      params.push(filters.pageId);
    }
    if (filters.browser) {
      where.push(`${browserExpr} = ?`);
      params.push(filters.browser);
    }
    if (filters.viewport) {
      where.push(`${viewportExpr} = ?`);
      params.push(filters.viewport);
    }
    if (filters.status && view.statusColumn) {
      where.push(`d.${view.statusColumn} = ?`);
      params.push(filters.status);
    }
    if (filters.extra && view.extraFilter && view.extraFilter.options.some((o) => o.value === filters.extra)) {
      where.push(`d.${view.extraFilter.column} = ?`);
      params.push(filters.extra);
    }
    const selected = view.columns.map((c) => c.key).filter((k) => cols.includes(k));
    const from = `FROM ${view.table} d LEFT JOIN pages pg ON pg.id = d.page_id LEFT JOIN test_results tr ON tr.id = d.test_result_id WHERE ${where.join(" AND ")}`;
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c ${from}`).get(...params) as Row).c);
    const rows = this.db
      .prepare(
        `SELECT d.id, d.page_id, ${selected.map((k) => `d.${k}`).join(", ")}, pg.url AS page_url, ${browserExpr} AS browser_name, ${viewportExpr} AS viewport_id
         ${from} ORDER BY ${view.orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...params, clampLimit(filters.limit, 1000), Math.max(0, filters.offset ?? 0)) as DetailRowRecord[];
    return { rows, total };
  }
}

export class LocalTestCaseRepository implements TestCaseRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(options: ListOptions = {}): Promise<TestCaseRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) {
      where.push("tc.project_id = ?");
      params.push(options.projectId);
    }
    if (options.testRunId) {
      where.push("tc.test_run_id = ?");
      params.push(options.testRunId);
    }
    const rows = this.db
      .prepare(
        `SELECT tc.*, p.name AS project_name,
           (SELECT json_group_array(json_object('status', s.status, 'count', s.c)) FROM
              (SELECT status, COUNT(*) AS c FROM test_results WHERE test_case_id = tc.id GROUP BY status) s) AS result_summary
         FROM test_cases tc JOIN projects p ON p.id = tc.project_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY tc.created_at DESC, tc.code ASC LIMIT ?`,
      )
      .all(...params, clampLimit(options.limit, 5000)) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      projectName: String(row.project_name),
      testRunId: str(row.test_run_id),
      module: String(row.module),
      title: String(row.title),
      priority: str(row.priority),
      source: String(row.source),
      createdAt: String(row.created_at),
      code: str(row.code),
      pageUrl: str(row.page_url),
      section: str(row.section),
      scenarioType: str(row.scenario_type) as TestCaseRecord["scenarioType"],
      feature: str(row.feature),
      element: str(row.element),
      preconditions: str(row.preconditions),
      testData: str(row.test_data),
      steps: json(row.steps, []),
      expectedResult: str(row.expected_result),
      resultSummary: json<{ status: string; count: number }[]>(row.result_summary, []),
    }));
  }
}

// ---------------------------------------------------------------- workers

export class LocalWorkerRepository implements WorkerRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async status(staleAfterMs = 15_000): Promise<WorkerStatus> {
    const row = this.db.prepare("SELECT * FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1").get() as Row | undefined;
    if (!row) return { online: false, lastSeenAt: null, handlers: [] };
    const lastSeen = String(row.last_seen_at);
    return { online: Date.now() - new Date(lastSeen).getTime() < staleAfterMs, lastSeenAt: lastSeen, handlers: json(row.handlers, []) };
  }
}
