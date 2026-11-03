import type { AppEnv } from "@/lib/config/env";
import { sqlRepositories } from "../local/local-database-provider";
import type {
  ActivityRepository,
  BugRepository,
  CrawlRunRepository,
  DashboardRepository,
  DatabaseHealth,
  DatabaseProvider,
  DocumentRepository,
  ExternalTestRepository,
  HistoryRepository,
  OwnershipRepository,
  PageRepository,
  ProjectRepository,
  ReportRepository,
  TestCaseRepository,
  TestConfigurationRepository,
  TestResultRepository,
  TestRunRepository,
  WorkerRepository,
} from "../provider";
import { createPostgresExecutor, type PostgresExecutor } from "../sql/postgres-executor";
import { postgresConfig, type PostgresEnv } from "../sql/select-executor";

/**
 * DatabaseProvider on PostgreSQL (Supabase): the same repository classes as SQLite, on the PostgreSQL executor. The
 * schema comes from lib/database/postgres/migrations, applied separately (scripts/pg-migrate.ts); the app never
 * migrates PostgreSQL itself. The connection string stays server-side and is never logged.
 */
export class PostgresDatabaseProvider implements DatabaseProvider {
  readonly kind = "supabase" as const;
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

  constructor(readonly sql: PostgresExecutor) {
    const repos = sqlRepositories(sql);
    this.projects = repos.projects;
    this.documents = repos.documents;
    this.testConfigurations = repos.testConfigurations;
    this.testRuns = repos.testRuns;
    this.testResults = repos.testResults;
    this.crawlRuns = repos.crawlRuns;
    this.workers = repos.workers;
    this.pages = repos.pages;
    this.testCases = repos.testCases;
    this.bugs = repos.bugs;
    this.reports = repos.reports;
    this.history = repos.history;
    this.externalTests = repos.externalTests;
    this.activity = repos.activity;
    this.dashboard = repos.dashboard;
    this.ownership = repos.ownership;
  }

  async healthCheck(): Promise<DatabaseHealth> {
    try {
      await this.sql.get("SELECT 1");
      const applied = await this.sql.get<{ v: unknown }>("SELECT MAX(version) AS v FROM qa_pilot_migrations").catch(() => undefined);
      if (!applied || applied.v === null) return { ok: false, detail: "PostgreSQL reachable, but the schema has not been migrated (scripts/pg-migrate.ts).", schemaVersion: null };
      return { ok: true, detail: "PostgreSQL reachable, schema migrated", schemaVersion: Number(applied.v) };
    } catch (error) {
      // Only a code or name: connection errors can mention the host.
      const e = error as { code?: string; name?: string };
      return { ok: false, detail: `PostgreSQL unreachable (${e.code ?? e.name ?? "error"})`, schemaVersion: null };
    }
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

/**
 * The PostgreSQL provider for DATABASE_PROVIDER=supabase. Invalid settings throw a DatabaseConfigurationError naming
 * the variable (never its value); it never falls back to SQLite. No connection is made until the first query.
 */
export function createSupabaseDatabaseProvider(env: Pick<AppEnv, "DATABASE_PROVIDER"> & PostgresEnv): PostgresDatabaseProvider {
  const { url, options } = postgresConfig(env);
  return new PostgresDatabaseProvider(createPostgresExecutor(url, undefined, options));
}
