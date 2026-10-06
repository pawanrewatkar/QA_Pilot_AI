import type { Locator } from "playwright";
import type { PageSession } from "@/lib/playwright/page-session";
import type { BrowserName, EvidenceItem, TestRunOptions, Viewport } from "@/types";
import type { LinkChecker } from "./link-check";
import type { CheckOutcome } from "./outcome";

export interface FormLedger {
  hasSubmitted(kind: string, fingerprint: string): boolean;
  record(kind: string, fingerprint: string, pageUrl: string): void;
}

/** Everything a module needs to test one page in one browser + viewport. */
export interface PageTestContext {
  session: PageSession;
  pageId: string;
  url: string;
  browser: BrowserName;
  viewport: Viewport;
  options: TestRunOptions;
  project: { websiteUrl: string; testEmail: string | null; figmaUrl: string | null };
  selectedModules: ReadonlySet<string>;
  linkChecker: LinkChecker;
  formLedger: FormLedger;
  /** True for the first browser/viewport combination of the run (per-page checks run only here). */
  isPrimaryCombo: boolean;
  /** Console / page-error / network activity recorded during the initial page load. */
  loadObservations: import("./modules/observability").LoadObservations;
  /** Run-scoped state shared across pages and browsers (e.g. metadata for duplicate detection). */
  shared: Map<string, unknown>;
  /** The project's reference document, extracted once per run (null when none is uploaded or it cannot be read). */
  referenceDocument(): Promise<import("@/lib/content/types").ReferenceLoadResult>;
  /** Screenshot of the page (or one element) stored as evidence. */
  capture(label: string, target?: Locator): Promise<EvidenceItem | null>;
  /** Re-opens the page under test in a clean state. Returns false if it can no longer be loaded. */
  reload(): Promise<boolean>;
  isCancelled(): boolean;
  setCurrentTest(label: string): void;
}

export interface TestModule {
  id: string;
  /** "page": run once per page (browser-independent, e.g. HTTP link status). "combo": run per browser × viewport. */
  scope: "page" | "combo";
  run(ctx: PageTestContext): Promise<CheckOutcome[]>;
  /** Optional cross-page checks executed once after every page has been tested. */
  afterRun?(shared: Map<string, unknown>): Promise<{ page: { id: string; url: string }; outcome: CheckOutcome }[]>;
}
