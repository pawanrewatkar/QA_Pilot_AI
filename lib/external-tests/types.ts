/**
 * External Test Case Testing: test cases supplied by the user in an Excel workbook, executed
 * against a website with the existing browser engine, with results written back to Excel.
 */

/** Statuses of this module. The standard set plus HUMAN INTERACTION, for cases automation must not decide. */
export const EXTERNAL_STATUSES = ["PASS", "FAIL", "HUMAN INTERACTION", "NOT EXECUTED", "NOT APPLICABLE"] as const;
export type ExternalStatus = (typeof EXTERNAL_STATUSES)[number];

export const HUMAN_INTERACTION_TEXT = "This test case needs human interaction.";

/** Logical fields a test-case sheet can provide. */
export const CASE_FIELDS = ["caseId", "title", "scenario", "steps", "expected", "url", "testData", "preconditions"] as const;
export type CaseField = (typeof CASE_FIELDS)[number];

export const CASE_FIELD_LABELS: Record<CaseField, string> = {
  caseId: "Test Case ID",
  title: "Test Case",
  scenario: "Test Scenario",
  steps: "Test Steps",
  expected: "Expected Result",
  url: "Page URL",
  testData: "Test Data",
  preconditions: "Preconditions",
};

/** Field → 1-based column number in the worksheet (absent = not mapped). */
export type ColumnMapping = Partial<Record<CaseField, number>>;

export interface SheetColumn {
  /** 1-based column number. */
  index: number;
  header: string;
}

export interface SheetRow {
  /** 1-based worksheet row number. */
  rowNumber: number;
  /** Column number → cell text. */
  cells: Record<number, string>;
}

export interface ParsedSheet {
  name: string;
  headerRow: number;
  columns: SheetColumn[];
  rows: SheetRow[];
  /** Rows beyond MAX_TEST_CASES that were not read. */
  truncatedRows: number;
}

export interface ExternalCase {
  rowNumber: number;
  caseRef: string | null;
  title: string;
  steps: string | null;
  expected: string | null;
  url: string | null;
  testData: string | null;
  preconditions: string | null;
}

export type OutputMode = "EXISTING_SHEET" | "NEW_SHEET";
export type SourceKind = "UPLOAD" | "LOCAL_PATH" | "GOOGLE_DRIVE";

/** Header names of one execution's result columns, and where they are written. */
export interface ResultColumnSet {
  /** 1 for "Actual Result / Status / Date", 2 for "Actual Result 2 / …", and so on. */
  set: number;
  actual: { header: string; index: number; exists: boolean };
  status: { header: string; index: number; exists: boolean };
  date: { header: string; index: number; exists: boolean };
}

/** Maximum test cases read from one worksheet. */
export const MAX_TEST_CASES = 2000;

export type ExternalCounts = Record<ExternalStatus, number>;

/** One external execution, as listed and shown in the UI (backed by a test run). */
export interface ExternalExecutionRecord {
  runId: string;
  name: string | null;
  projectId: string;
  projectName: string;
  websiteUrl: string;
  sourceKind: SourceKind;
  sourceName: string;
  worksheet: string;
  outputMode: OutputMode;
  outputFileName: string | null;
  outputError: string | null;
  resultColumns: { sheet: string; set: number; actual: string; status: string; date: string } | null;
  runStatus: import("@/types").TestRunStatus;
  cancelRequested: boolean;
  currentTest: string | null;
  browsers: string[];
  viewports: string[];
  totalCases: number;
  /** Cases with an outcome in every selected browser × viewport (or a final status). */
  completedCases: number;
  counts: ExternalCounts;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface ExternalCaseRecord {
  id: string;
  rowNumber: number;
  caseRef: string | null;
  title: string;
  steps: string | null;
  expected: string | null;
  status: ExternalStatus | null;
  actual: string | null;
  executedAt: string | null;
  observations: { browser: string; viewport: string; status: ExternalStatus; actual: string; screenshotKey: string | null; testResultId: string | null }[];
}

export interface NewExternalExecution {
  projectId: string;
  name: string | null;
  websiteUrl: string;
  /** Page record of the website start URL (created by the caller through PageRepository.addManual). */
  pageId: string;
  source: { kind: SourceKind; name: string; storageKey: string };
  worksheet: string;
  headerRow: number;
  mapping: ColumnMapping;
  outputMode: OutputMode;
  browsers: import("@/types").BrowserName[];
  viewports: string[];
  allowFormSubmission: boolean;
  navigationTimeoutMs: number;
  cases: ExternalCase[];
}
