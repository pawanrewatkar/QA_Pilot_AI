import type {
  BrowserName,
  CrawlConfig,
  CrawlRun,
  PageCrawlStatus,
  PageType,
  ResultStatusCounts,
  TestResultRecord,
  TestResultStatus,
  TestRunDetail,
  TestRunOptions,
  WorkerStatus,
  ActivityRecord,
  BugRecord,
  DashboardMetrics,
  DocumentRecord,
  ListOptions,
  NewActivity,
  NewDocumentRecord,
  PageRecord,
  Project,
  ProjectInput,
  ProjectQuery,
  ProjectSummary,
  RegressionRecord,
  ReportRecord,
  ResultTrendPoint,
  TestCaseRecord,
  TestConfiguration,
  TestConfigurationInput,
  TestRun,
} from "@/types";

/**
 * Persistence contract for QA Pilot AI.
 *
 * Every method is async so that network-backed providers (e.g. a future
 * SupabaseDatabaseProvider) can implement the same interface as the local
 * SQLite provider without changing callers.
 */
export interface DatabaseProvider {
  readonly kind: DatabaseProviderKind;

  projects: ProjectRepository;
  documents: DocumentRepository;
  testConfigurations: TestConfigurationRepository;
  testRuns: TestRunRepository;
  testResults: TestResultRepository;
  crawlRuns: CrawlRunRepository;
  workers: WorkerRepository;
  pages: PageRepository;
  testCases: TestCaseRepository;
  bugs: BugRepository;
  reports: ReportRepository;
  activity: ActivityRepository;
  dashboard: DashboardRepository;

  healthCheck(): Promise<DatabaseHealth>;
  close(): Promise<void>;
}

export type DatabaseProviderKind = "local-sqlite" | "supabase";

export interface DatabaseHealth {
  ok: boolean;
  detail: string;
  schemaVersion: number | null;
}

export interface ProjectRepository {
  list(query?: ProjectQuery): Promise<ProjectSummary[]>;
  getById(id: string): Promise<ProjectSummary | null>;
  create(input: ProjectInput): Promise<Project>;
  update(id: string, input: ProjectInput): Promise<Project | null>;
  /** Deletes the project and every record that belongs to it. Returns false if it did not exist. */
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
}

export interface DocumentRepository {
  listByProject(projectId: string): Promise<DocumentRecord[]>;
  getById(id: string): Promise<DocumentRecord | null>;
  create(input: NewDocumentRecord): Promise<DocumentRecord>;
  delete(id: string): Promise<boolean>;
}

export interface TestConfigurationRepository {
  listByProject(projectId: string): Promise<TestConfiguration[]>;
  getById(id: string): Promise<TestConfiguration | null>;
  create(input: TestConfigurationInput): Promise<TestConfiguration>;
  update(id: string, input: TestConfigurationInput): Promise<TestConfiguration | null>;
  delete(id: string): Promise<boolean>;
}

export interface NewTestRun {
  projectId: string;
  configurationId: string | null;
  name: string | null;
  modules: string[];
  browsers: BrowserName[];
  viewports: string[];
  pageIds: string[];
  configurationName: string | null;
  options: TestRunOptions;
}

export interface TestRunRepository {
  list(options?: ListOptions): Promise<TestRun[]>;
  getById(id: string): Promise<TestRun | null>;
  getDetail(id: string): Promise<TestRunDetail | null>;
  /** Creates a PENDING run and enqueues it for the worker in one transaction. */
  createAndEnqueue(input: NewTestRun): Promise<TestRun>;
  /** Asks the worker to stop; a PENDING run is cancelled immediately. Returns false if already finished. */
  requestCancel(id: string): Promise<boolean>;
  countsByRun(runIds: string[]): Promise<Record<string, ResultStatusCounts>>;
}

export interface PageQuery extends ListOptions {
  search?: string;
  pageType?: PageType;
  crawlStatus?: PageCrawlStatus;
  selectedOnly?: boolean;
}

export interface PageRepository {
  list(options?: PageQuery): Promise<PageRecord[]>;
  count(options?: PageQuery): Promise<number>;
  getByIds(projectId: string, ids: string[]): Promise<PageRecord[]>;
  setSelected(projectId: string, ids: string[], selected: boolean): Promise<number>;
  /** Adds a manually entered URL (already validated and normalized). Returns the page and whether it was new. */
  addManual(projectId: string, url: string, normalizedUrl: string): Promise<{ page: PageRecord; created: boolean }>;
  remove(projectId: string, ids: string[]): Promise<number>;
}

export interface CrawlRunRepository {
  /** Creates a PENDING crawl and enqueues it for the worker in one transaction. */
  createAndEnqueue(projectId: string, startUrl: string, config: CrawlConfig): Promise<CrawlRun>;
  getById(id: string): Promise<CrawlRun | null>;
  latest(projectId: string): Promise<CrawlRun | null>;
  list(projectId: string, limit?: number): Promise<CrawlRun[]>;
  requestCancel(id: string): Promise<boolean>;
}

export interface TestResultQuery {
  status?: TestResultStatus;
  module?: string;
  browser?: BrowserName;
  viewport?: string;
  pageId?: string;
  limit?: number;
  offset?: number;
}

export interface TestResultRepository {
  listByRun(runId: string, query?: TestResultQuery): Promise<TestResultRecord[]>;
  countByRun(runId: string, query?: TestResultQuery): Promise<number>;
  /** True if the storage key belongs to evidence recorded by a run (guards artifact downloads). */
  isKnownArtifact(storageKey: string): Promise<boolean>;
  /** Rows of a per-check table (see lib/constants/detail-views.ts) for one run, newest-first within the view's ordering. */
  listDetails(runId: string, viewId: string, filters?: DetailFilters): Promise<{ rows: DetailRowRecord[]; total: number }>;
}

export interface DetailFilters {
  pageId?: string;
  browser?: string;
  viewport?: string;
  status?: string;
  extra?: string;
  limit?: number;
  offset?: number;
}

export type DetailRowRecord = Record<string, string | number | null> & { page_url: string | null; browser_name: string | null; viewport_id: string | null };

export interface WorkerRepository {
  status(staleAfterMs?: number): Promise<WorkerStatus>;
}

export interface TestCaseRepository {
  list(options?: ListOptions): Promise<TestCaseRecord[]>;
}

export interface BugRepository {
  list(options?: ListOptions): Promise<BugRecord[]>;
}

export interface ReportRepository {
  list(options?: ListOptions): Promise<ReportRecord[]>;
}

export interface ActivityRepository {
  record(entry: NewActivity): Promise<ActivityRecord>;
  list(options?: ListOptions): Promise<ActivityRecord[]>;
}

export interface DashboardRepository {
  getMetrics(): Promise<DashboardMetrics>;
  /** Daily PASS / FAIL / WARNING counts of executed results, oldest first. Days with no results are omitted. */
  getResultTrend(days: number): Promise<ResultTrendPoint[]>;
  getRegressions(limit?: number): Promise<RegressionRecord[]>;
}

export class DatabaseNotImplementedError extends Error {
  constructor(provider: string) {
    super(`The "${provider}" database provider is not implemented yet. Use DATABASE_PROVIDER=local.`);
    this.name = "DatabaseNotImplementedError";
  }
}
