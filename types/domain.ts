/**
 * Core domain types shared by the app, database providers and the worker.
 * String literal unions mirror the CHECK constraints in lib/database/schema.ts.
 */

export const TEST_RUN_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type TestRunStatus = (typeof TEST_RUN_STATUSES)[number];

/** Outcome of a single executed check. Deliberately separate from TestRunStatus. */
export const TEST_RESULT_STATUSES = ["PASS", "FAIL", "WARNING", "NOT EXECUTED", "NOT APPLICABLE"] as const;
export type TestResultStatus = (typeof TEST_RESULT_STATUSES)[number];

/** Statuses that assert something was actually executed and observed. */
export const EXECUTED_RESULT_STATUSES = ["PASS", "FAIL", "WARNING"] as const satisfies readonly TestResultStatus[];

export const BUG_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type BugSeverity = (typeof BUG_SEVERITIES)[number];

export const BUG_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "WONT_FIX"] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];

export const REPORT_STATUSES = ["GENERATING", "READY", "FAILED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_FORMATS = ["EXCEL", "PDF", "HTML", "JSON", "CSV"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const JOB_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type ISODateString = string;

export interface Project {
  id: string;
  name: string;
  websiteUrl: string;
  description: string | null;
  figmaUrl: string | null;
  testEmail: string | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface ProjectSummary extends Project {
  referenceDocument: DocumentRecord | null;
  testRunCount: number;
  pageCount: number;
  openBugCount: number;
  lastRunAt: ISODateString | null;
}

export interface ProjectInput {
  name: string;
  websiteUrl: string;
  description: string | null;
  figmaUrl: string | null;
  testEmail: string | null;
}

export type ProjectFilter = "all" | "with-figma" | "with-document" | "with-test-email" | "never-run";
export type ProjectSort = "updated" | "created" | "name";

export interface ProjectQuery {
  search?: string;
  filter?: ProjectFilter;
  sort?: ProjectSort;
}

export const DOCUMENT_KINDS = ["REFERENCE", "OTHER"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface DocumentRecord {
  id: string;
  projectId: string;
  kind: DocumentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  checksumSha256: string;
  createdAt: ISODateString;
}

export type NewDocumentRecord = Omit<DocumentRecord, "id" | "createdAt">;

export interface TestRun {
  id: string;
  projectId: string;
  projectName: string;
  configurationId: string | null;
  status: TestRunStatus;
  startedAt: ISODateString | null;
  completedAt: ISODateString | null;
  errorMessage: string | null;
  createdAt: ISODateString;
}

export interface PageRecord {
  id: string;
  projectId: string;
  projectName: string;
  url: string;
  title: string | null;
  httpStatus: number | null;
  discoveredVia: string | null;
  depth: number | null;
  lastSeenAt: ISODateString;
  name: string | null;
  description: string | null;
  pageType: import("./engine").PageType;
  pageTypeConfidence: number | null;
  crawlStatus: import("./engine").PageCrawlStatus;
  discoverySources: import("./engine").DiscoverySource[];
  isSelected: boolean;
  finalUrl: string | null;
  errorMessage: string | null;
}

export interface TestCaseRecord {
  id: string;
  projectId: string;
  projectName: string;
  testRunId: string | null;
  module: string;
  title: string;
  priority: string | null;
  source: string;
  createdAt: ISODateString;
  code: string | null;
  pageUrl: string | null;
  section: string | null;
  scenarioType: import("./engine").ScenarioType | null;
  feature: string | null;
  element: string | null;
  preconditions: string | null;
  testData: string | null;
  steps: string[];
  expectedResult: string | null;
  /** Latest recorded status across browsers/viewports, or null if never executed. */
  resultSummary: { status: string; count: number }[];
}

export interface BugRecord {
  id: string;
  projectId: string;
  projectName: string;
  testRunId: string | null;
  title: string;
  severity: BugSeverity;
  status: BugStatus;
  pageUrl: string | null;
  createdAt: ISODateString;
}

export interface ReportRecord {
  id: string;
  projectId: string;
  projectName: string;
  testRunId: string | null;
  format: ReportFormat;
  status: ReportStatus;
  fileName: string | null;
  sizeBytes: number | null;
  createdAt: ISODateString;
  completedAt: ISODateString | null;
}

export interface ActivityRecord {
  id: string;
  projectId: string | null;
  projectName: string | null;
  entityType: string;
  entityId: string | null;
  action: string;
  summary: string;
  createdAt: ISODateString;
}

export interface NewActivity {
  projectId: string | null;
  entityType: string;
  entityId: string | null;
  action: string;
  summary: string;
}

export interface DashboardMetrics {
  totalProjects: number;
  totalTestRuns: number;
  totalPagesTested: number;
  totalTestCases: number;
  passed: number;
  failed: number;
  warnings: number;
  bugs: number;
  criticalBugs: number;
  highBugs: number;
  mediumBugs: number;
  lowBugs: number;
}

export interface ResultTrendPoint {
  day: string; // YYYY-MM-DD
  passed: number;
  failed: number;
  warnings: number;
}

/** A test case that passed in a project's previous completed run and failed in its latest one. */
export interface RegressionRecord {
  projectId: string;
  projectName: string;
  testCaseId: string;
  testCaseTitle: string;
  previousRunId: string;
  latestRunId: string;
}

export interface ListOptions {
  limit?: number;
  projectId?: string;
  testRunId?: string;
}
