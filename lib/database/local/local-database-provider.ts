import { randomUUID } from "node:crypto";
import type {
  ResultStatusCounts,
  TestRunDetail,
  ActivityRecord,
  DashboardMetrics,
  DocumentKind,
  DocumentRecord,
  ListOptions,
  NewActivity,
  NewDocumentRecord,
  Project,
  ProjectInput,
  ProjectQuery,
  ProjectSummary,
  RegressionRecord,
  ResultTrendPoint,
  TestConfiguration,
  TestConfigurationInput,
  TestRun,
} from "@/types";
import type {
  CrawlRunRepository,
  NewTestRun,
  TestResultRepository,
  WorkerRepository,
  ActivityRepository,
  BugRepository,
  DashboardRepository,
  DatabaseHealth,
  DatabaseProvider,
  DocumentRepository,
  PageRepository,
  ProjectRepository,
  ReportRepository,
  HistoryRepository,
  ExternalTestRepository,
  OwnershipRepository,
  TestCaseRepository,
  TestConfigurationRepository,
  TestRunRepository,
} from "../provider";
import {
  cancelRun,
  countsForSql,
  createRunAndEnqueue,
  LocalCrawlRunRepository,
  LocalPageRepository,
  LocalTestCaseRepository,
  LocalTestResultRepository,
  LocalWorkerRepository,
  mapRunSummary,
  runDetailSql,
} from "./engine-repositories";
import { LocalBugRepository } from "./bug-repository";
import { LocalOwnershipRepository, ownedProjectIds, ownedRunIds } from "./ownership";
import { LocalHistoryRepository } from "./history-repository";
import { LocalExternalTestRepository } from "./external-test-repository";
import { LocalReportRepository } from "./report-repository";
import { getSchemaVersion, openSqlite, runMigrations, type SqliteDatabase } from "./sqlite-client";
import type { SqlExecutor, SqlValue } from "../sql/executor";
import { SqliteExecutor } from "../sql/sqlite-executor";

type Row = Record<string, unknown>;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const now = () => new Date().toISOString();
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Escapes LIKE wildcards so user search text is matched literally. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function mapProject(row: Row): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    websiteUrl: String(row.website_url),
    description: str(row.description),
    figmaUrl: str(row.figma_url),
    testEmail: str(row.test_email),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapDocument(row: Row): DocumentRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: String(row.kind) as DocumentKind,
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: num(row.size_bytes),
    storageKey: String(row.storage_key),
    checksumSha256: String(row.checksum_sha256),
    createdAt: String(row.created_at),
  };
}

function mapProjectSummary(row: Row): ProjectSummary {
  const doc = parseJson<Row | null>(row.reference_document, null);
  return {
    ...mapProject(row),
    referenceDocument: doc ? mapDocument(doc) : null,
    testRunCount: num(row.test_run_count),
    pageCount: num(row.page_count),
    openBugCount: num(row.open_bug_count),
    lastRunAt: str(row.last_run_at),
  };
}

function mapConfiguration(row: Row): TestConfiguration {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    scope: String(row.scope) as TestConfiguration["scope"],
    selectedPageIds: parseJson(row.selected_page_ids, []),
    manualUrls: parseJson(row.manual_urls, []),
    modules: parseJson(row.modules, []),
    browsers: parseJson(row.browsers, []),
    viewports: parseJson(row.viewports, []),
    reportFormats: parseJson(row.report_formats, []),
    reportSections: parseJson(row.report_sections, {} as TestConfiguration["reportSections"]),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const PROJECT_SUMMARY_SELECT = `
SELECT p.*,
  (SELECT COUNT(*) FROM test_runs r WHERE r.project_id = p.id) AS test_run_count,
  (SELECT COUNT(*) FROM pages pg WHERE pg.project_id = p.id) AS page_count,
  (SELECT COUNT(*) FROM bugs b WHERE b.project_id = p.id AND b.status IN ('OPEN','IN_PROGRESS')) AS open_bug_count,
  (SELECT MAX(COALESCE(r.started_at, r.created_at)) FROM test_runs r WHERE r.project_id = p.id) AS last_run_at,
  (SELECT json_object(
      'id', d.id, 'project_id', d.project_id, 'kind', d.kind, 'file_name', d.file_name,
      'mime_type', d.mime_type, 'size_bytes', d.size_bytes, 'storage_key', d.storage_key,
      'checksum_sha256', d.checksum_sha256, 'created_at', d.created_at)
    FROM documents d WHERE d.project_id = p.id AND d.kind = 'REFERENCE'
    ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS reference_document
FROM projects p`;

class LocalProjectRepository implements ProjectRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(query: ProjectQuery = {}): Promise<ProjectSummary[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    const search = query.search?.trim();
    if (search) {
      const pattern = likePattern(search);
      where.push(`(p.name LIKE ? ESCAPE '\\' OR p.website_url LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern, pattern);
    }

    if (query.ownerId !== undefined) {
      where.push("p.owner_id = ?");
      params.push(query.ownerId);
    }

    switch (query.filter) {
      case "with-figma":
        where.push("p.figma_url IS NOT NULL");
        break;
      case "with-document":
        where.push("EXISTS (SELECT 1 FROM documents d WHERE d.project_id = p.id AND d.kind = 'REFERENCE')");
        break;
      case "with-test-email":
        where.push("p.test_email IS NOT NULL");
        break;
      case "never-run":
        where.push("NOT EXISTS (SELECT 1 FROM test_runs r WHERE r.project_id = p.id)");
        break;
    }

    const orderBy =
      query.sort === "name"
        ? "p.name COLLATE NOCASE ASC, p.rowid ASC"
        : query.sort === "created"
          ? "p.created_at DESC, p.rowid DESC"
          : "p.updated_at DESC, p.rowid DESC";

    const sql = `${PROJECT_SUMMARY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapProjectSummary);
  }

  async getById(id: string): Promise<ProjectSummary | null> {
    const row = this.db.prepare(`${PROJECT_SUMMARY_SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
    return row ? mapProjectSummary(row) : null;
  }

  async create(input: ProjectInput, ownerId?: string): Promise<Project> {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, website_url, description, figma_url, test_email, created_at, updated_at, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // Without a trusted owner the project has none and is visible to no scoped identity (fail closed).
      .run(id, input.name, input.websiteUrl, input.description, input.figmaUrl, input.testEmail, ts, ts, ownerId ?? null);
    return mapProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row);
  }

  async update(id: string, input: ProjectInput): Promise<Project | null> {
    const result = this.db
      .prepare(
        `UPDATE projects SET name = ?, website_url = ?, description = ?, figma_url = ?, test_email = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.name, input.websiteUrl, input.description, input.figmaUrl, input.testEmail, now(), id);
    if (result.changes === 0) return null;
    return mapProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row);
  }

  async delete(id: string): Promise<boolean> {
    let deleted = false;
    const ts = now();
    this.db.transaction(() => {
      // Queued work for this project is cancelled and running work is asked to stop, so the worker
      // never picks up a job whose records are gone. (jobs has no foreign key: payloads are JSON.)
      this.db.prepare("UPDATE test_runs SET cancel_requested = 1 WHERE project_id = ? AND status IN ('PENDING','RUNNING')").run(id);
      this.db.prepare("UPDATE crawl_runs SET cancel_requested = 1 WHERE project_id = ? AND status IN ('PENDING','RUNNING')").run(id);
      this.db
        .prepare(
          `UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE status = 'PENDING' AND (
             json_extract(payload, '$.testRunId') IN (SELECT id FROM test_runs WHERE project_id = ?)
             OR json_extract(payload, '$.crawlRunId') IN (SELECT id FROM crawl_runs WHERE project_id = ?)
             OR json_extract(payload, '$.reportBundleId') IN (SELECT id FROM report_bundles WHERE project_id = ?))`,
        )
        .run(ts, id, id, id);
      deleted = this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
    })();
    return deleted;
  }

  async storagePrefixes(id: string): Promise<string[]> {
    const runs = this.db.prepare("SELECT id FROM test_runs WHERE project_id = ?").all(id) as Row[];
    const bundles = this.db.prepare("SELECT id FROM report_bundles WHERE project_id = ?").all(id) as Row[];
    return [...runs.map((r) => `runs/${String(r.id)}`), ...bundles.map((b) => `reports/${String(b.id)}`)];
  }

  async count(ownerId?: string): Promise<number> {
    return ownerId === undefined
      ? num((this.db.prepare("SELECT COUNT(*) AS c FROM projects").get() as Row).c)
      : num((this.db.prepare("SELECT COUNT(*) AS c FROM projects WHERE owner_id = ?").get(ownerId) as Row).c);
  }
}

/** First repository on SqlExecutor (Phase 3.1b). Same SQL and results as the former direct better-sqlite3 version. */
export class LocalDocumentRepository implements DocumentRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async listByProject(projectId: string): Promise<DocumentRecord[]> {
    // `rowid` (insertion order for equal timestamps) is SQLite-only; kept so ordering is unchanged. A PostgreSQL
    // schema needs an explicit insertion-order column on documents before this query can be shared.
    return (await this.sql.all<Row>("SELECT * FROM documents WHERE project_id = ? ORDER BY created_at DESC, rowid DESC", [projectId])).map(mapDocument);
  }

  async getById(id: string): Promise<DocumentRecord | null> {
    const row = await this.sql.get<Row>("SELECT * FROM documents WHERE id = ?", [id]);
    return row ? mapDocument(row) : null;
  }

  async create(input: NewDocumentRecord): Promise<DocumentRecord> {
    const id = randomUUID();
    await this.sql.run(
      `INSERT INTO documents (id, project_id, kind, file_name, mime_type, size_bytes, storage_key, checksum_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.kind, input.fileName, input.mimeType, input.sizeBytes, input.storageKey, input.checksumSha256, now()],
    );
    return mapDocument((await this.sql.get<Row>("SELECT * FROM documents WHERE id = ?", [id])) as Row);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.sql.run("DELETE FROM documents WHERE id = ?", [id])).changes > 0;
  }
}

/** On SqlExecutor (Phase 3.1c). Same SQL, parameter order and results as the former direct better-sqlite3 version. */
export class LocalTestConfigurationRepository implements TestConfigurationRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async listByProject(projectId: string): Promise<TestConfiguration[]> {
    // `rowid` (insertion order for equal timestamps) is SQLite-only; kept so ordering is unchanged. A PostgreSQL
    // schema needs an explicit insertion-order column on test_configurations before this query can be shared.
    return (await this.sql.all<Row>("SELECT * FROM test_configurations WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC", [projectId])).map(mapConfiguration);
  }

  async getById(id: string): Promise<TestConfiguration | null> {
    const row = await this.sql.get<Row>("SELECT * FROM test_configurations WHERE id = ?", [id]);
    return row ? mapConfiguration(row) : null;
  }

  async create(input: TestConfigurationInput): Promise<TestConfiguration> {
    const id = randomUUID();
    const ts = now();
    await this.sql.run(
      `INSERT INTO test_configurations
          (id, project_id, name, scope, selected_page_ids, manual_urls, modules, browsers, viewports,
           report_formats, report_sections, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.name, input.scope, ...this.serialize(input), ts, ts],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: TestConfigurationInput): Promise<TestConfiguration | null> {
    const result = await this.sql.run(
      `UPDATE test_configurations SET name = ?, scope = ?, selected_page_ids = ?, manual_urls = ?, modules = ?,
           browsers = ?, viewports = ?, report_formats = ?, report_sections = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      [input.name, input.scope, ...this.serialize(input), now(), id, input.projectId],
    );
    return result.changes === 0 ? null : this.getById(id);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.sql.run("DELETE FROM test_configurations WHERE id = ?", [id])).changes > 0;
  }

  private serialize(input: TestConfigurationInput) {
    return [
      JSON.stringify(input.selectedPageIds),
      JSON.stringify(input.manualUrls),
      JSON.stringify(input.modules),
      JSON.stringify(input.browsers),
      JSON.stringify(input.viewports),
      JSON.stringify(input.reportFormats),
      JSON.stringify(input.reportSections),
    ] as const;
  }
}

function projectScope(options: ListOptions, alias: string, ownerColumn?: string): { clause: string; params: SqlValue[] } {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (options.projectId) {
    where.push(`${alias}.project_id = ?`);
    params.push(options.projectId);
  }
  if (options.ownerId !== undefined) {
    where.push(ownerColumn ? `${ownerColumn} = ?` : ownedProjectIds(`${alias}.project_id`));
    params.push(options.ownerId);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/**
 * Partially on SqlExecutor:
 * - `list` and `getById` (Phase 3.1e), `getDetail` and `countsByRun` (Phase 3.1i) use `sql` (same SQL, parameter
 *   order and results as before);
 * - `createAndEnqueue` and `requestCancel` still call the engine helpers with the raw connection `db`: both run a
 *   synchronous SQLite transaction (cancelling a pending run also cancels its queued job atomically). They move in
 *   the transactional phase.
 */
export class LocalTestRunRepository implements TestRunRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly sql: SqlExecutor,
  ) {}

  async list(options: ListOptions = {}): Promise<TestRun[]> {
    const { clause, params } = projectScope(options, "r");
    // `r.rowid` (insertion order for equal timestamps) is SQLite-only; kept so ordering is unchanged. A PostgreSQL
    // schema needs an explicit insertion-order column on test_runs before this query can be shared.
    const rows = await this.sql.all<Row>(
      `SELECT r.*, p.name AS project_name FROM test_runs r JOIN projects p ON p.id = r.project_id
         ${clause} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`,
      [...params, clampLimit(options.limit)],
    );
    return rows.map(mapRunSummary);
  }

  async getById(id: string): Promise<TestRun | null> {
    const row = await this.sql.get<Row>(`SELECT r.*, p.name AS project_name FROM test_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`, [id]);
    return row ? mapRunSummary(row) : null;
  }

  async getDetail(id: string): Promise<TestRunDetail | null> {
    return runDetailSql(this.sql, id);
  }

  async createAndEnqueue(input: NewTestRun): Promise<TestRun> {
    return (await this.getById(createRunAndEnqueue(this.db, input)))!;
  }

  async requestCancel(id: string): Promise<boolean> {
    return cancelRun(this.db, id);
  }

  async countsByRun(runIds: string[]): Promise<Record<string, ResultStatusCounts>> {
    return countsForSql(this.sql, runIds);
  }
}

/** On SqlExecutor (Phase 3.1d). Same SQL, parameter order and results as the former direct better-sqlite3 version. */
export class LocalActivityRepository implements ActivityRepository {
  constructor(private readonly sql: SqlExecutor) {}

  private map(row: Row): ActivityRecord {
    return {
      id: String(row.id),
      projectId: str(row.project_id),
      projectName: str(row.project_name),
      entityType: String(row.entity_type),
      entityId: str(row.entity_id),
      action: String(row.action),
      summary: String(row.summary),
      createdAt: String(row.created_at),
    };
  }

  async record(entry: NewActivity): Promise<ActivityRecord> {
    const id = randomUUID();
    await this.sql.run(
      `INSERT INTO activity_log (id, project_id, entity_type, entity_id, action, summary, created_at, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT owner_id FROM projects WHERE id = ?)))`,
      [id, entry.projectId, entry.entityType, entry.entityId, entry.action, entry.summary, now(), entry.ownerId ?? null, entry.projectId],
    );
    const row = (await this.sql.get<Row>(
      `SELECT a.*, p.name AS project_name FROM activity_log a LEFT JOIN projects p ON p.id = a.project_id WHERE a.id = ?`,
      [id],
    )) as Row;
    return this.map(row);
  }

  async list(options: ListOptions = {}): Promise<ActivityRecord[]> {
    const { clause, params } = projectScope(options, "a", "a.owner_id");
    // `a.rowid` (insertion order for equal timestamps) is SQLite-only; kept so ordering is unchanged. A PostgreSQL
    // schema needs an explicit insertion-order column on activity_log before this query can be shared.
    const rows = await this.sql.all<Row>(
      `SELECT a.*, p.name AS project_name FROM activity_log a LEFT JOIN projects p ON p.id = a.project_id
         ${clause} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
      [...params, clampLimit(options.limit)],
    );
    return rows.map((r) => this.map(r));
  }
}

/**
 * On SqlExecutor: `getResultTrend` (Phase 3.1f), `getMetrics` (Phase 3.1g) and `getRegressions` (Phase 3.1h) use
 * `sql` (same SQL, parameters and results as before).
 */
export class LocalDashboardRepository implements DashboardRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async getMetrics(ownerId?: string): Promise<DashboardMetrics> {
    // With an owner, every count is restricted to that owner's projects (each fragment binds the owner id once).
    const scoped = ownerId !== undefined;
    const and = (fragment: string) => (scoped ? ` AND ${fragment}` : "");
    const where = (fragment: string) => (scoped ? ` WHERE ${fragment}` : "");
    const sql = `SELECT
          (SELECT COUNT(*) FROM projects${where("owner_id = ?")}) AS total_projects,
          (SELECT COUNT(*) FROM test_runs${where(ownedProjectIds("project_id"))}) AS total_test_runs,
          (SELECT COUNT(DISTINCT page_id) FROM test_run_pages WHERE status = 'COMPLETED'${and(ownedRunIds("test_run_id"))}) AS total_pages_tested,
          (SELECT COUNT(*) FROM test_cases${where(ownedProjectIds("project_id"))}) AS total_test_cases,
          (SELECT COUNT(*) FROM test_results WHERE status = 'PASS'${and(ownedRunIds("test_run_id"))}) AS passed,
          (SELECT COUNT(*) FROM test_results WHERE status = 'FAIL'${and(ownedRunIds("test_run_id"))}) AS failed,
          (SELECT COUNT(*) FROM test_results WHERE status = 'WARNING'${and(ownedRunIds("test_run_id"))}) AS warnings,
          (SELECT COUNT(*) FROM test_results WHERE status = 'NOT EXECUTED'${and(ownedRunIds("test_run_id"))}) AS not_executed,
          (SELECT COUNT(*) FROM bugs${where(ownedProjectIds("project_id"))}) AS bugs,
          (SELECT COUNT(*) FROM bugs WHERE status IN ('OPEN','REOPENED','IN_PROGRESS')${and(ownedProjectIds("project_id"))}) AS open_bugs,
          (SELECT COUNT(*) FROM bugs WHERE severity = 'CRITICAL'${and(ownedProjectIds("project_id"))}) AS critical_bugs,
          (SELECT COUNT(*) FROM bugs WHERE severity = 'HIGH'${and(ownedProjectIds("project_id"))}) AS high_bugs,
          (SELECT COUNT(*) FROM bugs WHERE severity = 'MEDIUM'${and(ownedProjectIds("project_id"))}) AS medium_bugs,
          (SELECT COUNT(*) FROM bugs WHERE severity = 'LOW'${and(ownedProjectIds("project_id"))}) AS low_bugs`;
    const row = (await this.sql.get<Row>(sql, scoped ? Array(14).fill(ownerId) : [])) as Row;
    return {
      totalProjects: num(row.total_projects),
      totalTestRuns: num(row.total_test_runs),
      totalPagesTested: num(row.total_pages_tested),
      totalTestCases: num(row.total_test_cases),
      passed: num(row.passed),
      failed: num(row.failed),
      warnings: num(row.warnings),
      notExecuted: num(row.not_executed),
      bugs: num(row.bugs),
      openBugs: num(row.open_bugs),
      criticalBugs: num(row.critical_bugs),
      highBugs: num(row.high_bugs),
      mediumBugs: num(row.medium_bugs),
      lowBugs: num(row.low_bugs),
    };
  }

  async getResultTrend(days: number, ownerId?: string): Promise<ResultTrendPoint[]> {
    const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
    // `SUM(CASE …)` rather than `SUM(status = '…')`: PostgreSQL cannot SUM a boolean (Phase 3.3a); same counts on SQLite.
    const rows = await this.sql.all<Row>(
      `SELECT substr(executed_at, 1, 10) AS day,
           SUM(CASE WHEN status = 'PASS' THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN status = 'FAIL' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'WARNING' THEN 1 ELSE 0 END) AS warnings
         FROM test_results
         WHERE executed_at IS NOT NULL AND executed_at >= ? AND status IN ('PASS','FAIL','WARNING')${ownerId !== undefined ? ` AND ${ownedRunIds("test_run_id")}` : ""}
         GROUP BY day ORDER BY day ASC`,
      [since, ...(ownerId !== undefined ? [ownerId] : [])],
    );
    return rows.map((r) => ({ day: String(r.day), passed: num(r.passed), failed: num(r.failed), warnings: num(r.warnings) }));
  }

  async getRegressions(limit = 20, ownerId?: string): Promise<RegressionRecord[]> {
    // Compares each project's two most recent COMPLETED runs. Test cases are matched by
    // identity (module + title + page) because cases may be regenerated per run.
    // Ties on the completion time are broken by `rowid DESC` (the later-inserted run counts as newer). `rowid` is
    // SQLite's implicit row number (test_runs has a TEXT primary key, so it is not an alias of `id`); PostgreSQL has
    // no equivalent, so a shared version needs an explicit, stored tie-break (e.g. an insertion sequence column).
    const rows = await this.sql.all<Row>(
      `WITH ranked AS (
           SELECT id, project_id,
             ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY COALESCE(completed_at, created_at) DESC, rowid DESC) AS rn
           FROM test_runs WHERE status = 'COMPLETED'${ownerId !== undefined ? ` AND ${ownedProjectIds("project_id")}` : ""}
         )
         SELECT DISTINCT latest.project_id, p.name AS project_name, ltc.id AS test_case_id, ltc.title AS test_case_title,
           prev.id AS previous_run_id, latest.id AS latest_run_id
         FROM ranked latest
         JOIN ranked prev ON prev.project_id = latest.project_id AND prev.rn = 2
         JOIN projects p ON p.id = latest.project_id
         JOIN test_results lr ON lr.test_run_id = latest.id AND lr.status = 'FAIL'
         JOIN test_cases ltc ON ltc.id = lr.test_case_id
         JOIN test_results pr ON pr.test_run_id = prev.id AND pr.status = 'PASS'
         JOIN test_cases ptc ON ptc.id = pr.test_case_id
           AND ptc.module = ltc.module AND ptc.title = ltc.title AND COALESCE(ptc.page_id, '') = COALESCE(ltc.page_id, '')
         WHERE latest.rn = 1
         LIMIT ?`,
      [...(ownerId !== undefined ? [ownerId] : []), clampLimit(limit)],
    );
    return rows.map((r) => ({
      projectId: String(r.project_id),
      projectName: String(r.project_name),
      testCaseId: String(r.test_case_id),
      testCaseTitle: String(r.test_case_title),
      previousRunId: String(r.previous_run_id),
      latestRunId: String(r.latest_run_id),
    }));
  }
}

export class LocalDatabaseProvider implements DatabaseProvider {
  readonly kind = "local-sqlite" as const;

  readonly projects: ProjectRepository;
  readonly documents: DocumentRepository;
  readonly testConfigurations: TestConfigurationRepository;
  readonly testRuns: TestRunRepository;
  readonly testResults: TestResultRepository;
  readonly crawlRuns: CrawlRunRepository;
  readonly workers: WorkerRepository;
  readonly pages: PageRepository;
  readonly testCases: TestCaseRepository;
  readonly bugs: BugRepository;
  readonly reports: ReportRepository;
  readonly history: HistoryRepository;
  readonly externalTests: ExternalTestRepository;
  readonly activity: ActivityRepository;
  readonly dashboard: DashboardRepository;
  readonly ownership: OwnershipRepository;

  /** Exposed for the worker and tests; app code should go through the repositories. */
  readonly sqlite: SqliteDatabase;
  /** Async, database-neutral access to the same connection (repositories are moved onto it step by step). */
  readonly sql: SqlExecutor;

  constructor(db: SqliteDatabase) {
    this.sqlite = db;
    this.sql = new SqliteExecutor(db);
    this.projects = new LocalProjectRepository(db);
    this.documents = new LocalDocumentRepository(this.sql);
    this.testConfigurations = new LocalTestConfigurationRepository(this.sql);
    this.testRuns = new LocalTestRunRepository(db, this.sql);
    this.testResults = new LocalTestResultRepository(db, this.sql);
    this.crawlRuns = new LocalCrawlRunRepository(db);
    this.workers = new LocalWorkerRepository(this.sql);
    this.pages = new LocalPageRepository(db);
    this.testCases = new LocalTestCaseRepository(this.sql);
    this.bugs = new LocalBugRepository(db);
    this.reports = new LocalReportRepository(db);
    this.history = new LocalHistoryRepository(db, this.sql);
    this.externalTests = new LocalExternalTestRepository(db);
    this.activity = new LocalActivityRepository(this.sql);
    this.dashboard = new LocalDashboardRepository(this.sql);
    this.ownership = new LocalOwnershipRepository(this.sql);
  }

  /** Opens the database file and applies pending migrations. */
  static open(filePath: string): LocalDatabaseProvider {
    const db = openSqlite(filePath);
    runMigrations(db);
    return new LocalDatabaseProvider(db);
  }

  async healthCheck(): Promise<DatabaseHealth> {
    try {
      this.sqlite.prepare("SELECT 1").get();
      const integrity = this.sqlite.pragma("quick_check", { simple: true });
      const schemaVersion = getSchemaVersion(this.sqlite);
      return {
        ok: integrity === "ok",
        detail: integrity === "ok" ? "SQLite reachable, integrity check passed" : `Integrity check: ${String(integrity)}`,
        schemaVersion,
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Unknown database error", schemaVersion: null };
    }
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }
}
