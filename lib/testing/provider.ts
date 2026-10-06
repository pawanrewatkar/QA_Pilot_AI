import type { BrowserName, TestResultStatus, Viewport } from "@/types";

/**
 * Executes test modules against a page in a real browser and reports what it observed.
 *
 * Contract:
 * - PASS / FAIL / WARNING may only be returned for checks that actually executed.
 * - A check that could not run must be NOT EXECUTED (with a reason), and a check that does
 *   not apply to the page must be NOT APPLICABLE. Never default to PASS.
 * - Evidence (screenshots, logs) must be captured from the run, never synthesized.
 */
export interface TestingProvider {
  readonly id: string;
  readonly supportedModules: ReadonlySet<string>;
  execute(request: PageTestRequest, signal?: AbortSignal): Promise<ModuleExecutionResult[]>;
}

export interface PageTestRequest {
  testRunId: string;
  pageId: string;
  url: string;
  browser: BrowserName;
  viewport: Viewport;
  modules: string[];
}

export interface ModuleExecutionResult {
  module: string;
  checks: CheckResult[];
}

export interface CheckResult {
  checkKey: string;
  title: string;
  status: TestResultStatus;
  message: string;
  /** Required whenever status is PASS, FAIL or WARNING. */
  executedAt: string | null;
  durationMs: number | null;
  evidenceKeys: string[];
}
