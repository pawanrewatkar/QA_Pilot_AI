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

export const BUG_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "REOPENED", "WONT_FIX"] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];

export const BUG_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type BugPriority = (typeof BUG_PRIORITIES)[number];

export type ScreenshotKind = "VIEWPORT" | "FULL_PAGE" | "ELEMENT";

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
  code: string | null;
  projectId: string;
  projectName: string;
  testRunId: string | null;
  title: string;
  severity: BugSeverity;
  priority: BugPriority;
  status: BugStatus;
  pageUrl: string | null;
  pageName: string | null;
  section: string | null;
  testType: string | null;
  scenarioType: string | null;
  browser: string | null;
  viewport: string | null;
  element: string | null;
  selector: string | null;
  occurrenceCount: number;
  firstSeenRunId: string | null;
  lastSeenRunId: string | null;
  lastSeenAt: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface BugEvidenceRecord {
  id: string;
  type: "SCREENSHOT" | "CONSOLE_LOG" | "NETWORK_LOG" | "HTML_SNAPSHOT" | "VIDEO" | "TRACE" | "OTHER";
  label: string | null;
  screenshotKind: ScreenshotKind | null;
  storageKey: string | null;
  content: string | null;
  testRunId: string | null;
  testResultId: string | null;
  url: string | null;
  browser: string | null;
  viewport: string | null;
  selector: string | null;
  capturedAt: ISODateString | null;
}

export interface BugOccurrenceRecord {
  id: string;
  testRunId: string;
  testRunName: string | null;
  testResultId: string | null;
  browser: string | null;
  viewport: string | null;
  actualResult: string | null;
  observedAt: ISODateString;
}

export interface BugHistoryRecord {
  id: string;
  fromStatus: BugStatus | null;
  toStatus: BugStatus;
  note: string | null;
  source: "USER" | "ENGINE";
  changedAt: ISODateString;
}

export interface BugDetail extends BugRecord {
  description: string | null;
  severityReason: string | null;
  expectedResult: string | null;
  actualResult: string | null;
  stepsToReproduce: string | null;
  technicalDetails: string | null;
  screenshotKey: string | null;
  testCaseId: string | null;
  testResultId: string | null;
  evidence: BugEvidenceRecord[];
  occurrences: BugOccurrenceRecord[];
  history: BugHistoryRecord[];
}

export interface BugQuery {
  projectId?: string;
  testRunId?: string;
  search?: string;
  severity?: BugSeverity;
  priority?: BugPriority;
  status?: BugStatus;
  pageId?: string;
  testType?: string;
  browser?: string;
  device?: "desktop" | "mobile";
  limit?: number;
  offset?: number;
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

export type ReportKind = "PDF" | "HTML" | "TESTING_EXCEL" | "BUG_EXCEL";

export interface ReportFileRecord {
  id: string;
  kind: ReportKind | null;
  format: ReportFormat;
  status: ReportStatus;
  fileName: string | null;
  sizeBytes: number | null;
  errorMessage: string | null;
}

/** One "Generate report" request: the PDF, HTML, testing Excel and bug Excel for a run. */
export interface ReportBundleRecord {
  id: string;
  projectId: string;
  projectName: string;
  testRunId: string | null;
  testRunName: string | null;
  name: string;
  website: string;
  status: ReportStatus;
  errorMessage: string | null;
  createdAt: ISODateString;
  completedAt: ISODateString | null;
  files: ReportFileRecord[];
}

export interface RunHistoryRecord {
  id: string;
  name: string | null;
  projectId: string;
  projectName: string;
  website: string;
  status: TestRunStatus;
  createdAt: ISODateString;
  completedAt: ISODateString | null;
  pages: number;
  totalTests: number;
  counts: { PASS: number; FAIL: number; WARNING: number; "NOT EXECUTED": number; "NOT APPLICABLE": number };
  bugs: number;
  newBugs: number;
  severity: Record<BugSeverity, number>;
  /** Average local Lighthouse/browser performance score (0–1) of measured pages, or null if none measured. */
  performanceScore: number | null;
  /** Average LCP (ms) of measured pages, or null. */
  lcpMs: number | null;
  /** Failed / executed accessibility checks, or null if accessibility was not tested. */
  accessibility: { failed: number; executed: number } | null;
  seo: { failed: number; executed: number } | null;
}

export interface HistoryQuery {
  projectId?: string;
  search?: string;
  status?: TestRunStatus;
  limit?: number;
  offset?: number;
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
  notExecuted: number;
  bugs: number;
  /** OPEN, REOPENED or IN_PROGRESS. */
  openBugs: number;
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
