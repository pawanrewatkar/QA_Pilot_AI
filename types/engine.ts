import type { BrowserName } from "./test-config";
import type { TestResultStatus, TestRunStatus } from "./domain";

export const PAGE_TYPES = [
  "HOMEPAGE",
  "LANDING_PAGE",
  "ABOUT",
  "CONTACT",
  "SERVICES",
  "PRODUCT_LISTING",
  "PRODUCT_DETAIL",
  "COLLECTION",
  "BLOG_LISTING",
  "BLOG_DETAIL",
  "FAQ",
  "PRICING",
  "LOGIN",
  "SIGNUP",
  "DASHBOARD",
  "SEARCH",
  "CART",
  "CHECKOUT",
  "ACCOUNT",
  "OTHER",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  HOMEPAGE: "Homepage",
  LANDING_PAGE: "Landing Page",
  ABOUT: "About",
  CONTACT: "Contact",
  SERVICES: "Services",
  PRODUCT_LISTING: "Product Listing",
  PRODUCT_DETAIL: "Product Detail",
  COLLECTION: "Collection",
  BLOG_LISTING: "Blog Listing",
  BLOG_DETAIL: "Blog Detail",
  FAQ: "FAQ",
  PRICING: "Pricing",
  LOGIN: "Login",
  SIGNUP: "Signup",
  DASHBOARD: "Dashboard",
  SEARCH: "Search",
  CART: "Cart",
  CHECKOUT: "Checkout",
  ACCOUNT: "Account",
  OTHER: "Other",
};

export const PAGE_CRAWL_STATUSES = ["DISCOVERED", "CRAWLED", "FAILED", "SKIPPED"] as const;
export type PageCrawlStatus = (typeof PAGE_CRAWL_STATUSES)[number];

/** Where a URL was found. A page can have several. */
export const DISCOVERY_SOURCES = [
  "start",
  "header",
  "navigation",
  "footer",
  "cta",
  "button",
  "breadcrumb",
  "pagination",
  "content",
  "sitemap",
  "robots-sitemap",
  "redirect",
  "manual",
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export type QueryParamMode = "keep" | "strip-tracking" | "strip-all";

export interface CrawlConfig {
  maxDepth: number;
  maxPages: number;
  /** Per-page navigation timeout in milliseconds. */
  timeoutMs: number;
  retries: number;
  /** Substring or glob (`*`) patterns matched against the URL path + query. */
  exclusions: string[];
  sameDomainOnly: boolean;
  includeSubdomains: boolean;
  respectRobotsTxt: boolean;
  useSitemap: boolean;
  queryParams: QueryParamMode;
}

export interface CrawlRun {
  id: string;
  projectId: string;
  status: TestRunStatus;
  config: CrawlConfig;
  startUrl: string;
  resolvedStartUrl: string | null;
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesFailed: number;
  pagesSkipped: number;
  currentUrl: string | null;
  currentDepth: number;
  maxDepthReached: number;
  cancelRequested: boolean;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export const SCENARIO_TYPES = ["FUNCTIONAL", "POSITIVE", "NEGATIVE", "EDGE", "BOUNDARY"] as const;
export type ScenarioType = (typeof SCENARIO_TYPES)[number];

export interface EvidenceItem {
  type: "screenshot" | "http" | "console" | "network" | "dom" | "download" | "note";
  label: string;
  storageKey?: string;
  content?: string;
}

export interface TestResultRecord {
  id: string;
  testRunId: string;
  testCaseId: string;
  caseCode: string | null;
  pageId: string | null;
  url: string | null;
  module: string;
  section: string | null;
  scenarioType: ScenarioType | null;
  feature: string | null;
  element: string | null;
  title: string;
  expectationSource: ExpectationSource;
  preconditions: string | null;
  testData: string | null;
  steps: string[];
  expectedResult: string | null;
  actualResult: string | null;
  status: TestResultStatus;
  message: string | null;
  browser: BrowserName | null;
  viewport: string | null;
  evidence: EvidenceItem[];
  verifications: string[];
  durationMs: number | null;
  executedAt: string | null;
}

export interface ResultStatusCounts {
  PASS: number;
  FAIL: number;
  WARNING: number;
  "NOT EXECUTED": number;
  "NOT APPLICABLE": number;
}

/**
 * Where a test case's expected behaviour comes from, highest authority first. Lower-priority
 * sources never override higher ones, and AI-derived expectations can never produce a FAIL.
 */
export const EXPECTATION_SOURCES = [
  "REQUIREMENT",
  "ACCEPTANCE_CRITERIA",
  "FIGMA",
  "REFERENCE_DOCUMENT",
  "BROWSER_STANDARD",
  "DETECTED_FUNCTIONALITY",
  "AI_EXPLORATORY",
] as const;
export type ExpectationSource = (typeof EXPECTATION_SOURCES)[number];

export const TYPOGRAPHY_MODES = ["TYPOGRAPHY_ONLY", "TYPOGRAPHY_TAGS", "TYPOGRAPHY_CONTENT", "COMPLETE_UI"] as const;
export type TypographyMode = (typeof TYPOGRAPHY_MODES)[number];

export const CONTENT_COMPARISON_MODES = ["EXACT", "SECTION", "SEMANTIC"] as const;
export type ContentComparisonMode = (typeof CONTENT_COMPARISON_MODES)[number];

/** Page regions that can be left out of content comparison. */
export const CONTENT_EXCLUSIONS = ["header", "footer", "navigation", "cookie", "author", "reviews", "ads", "recommendations", "dynamic"] as const;
export type ContentExclusion = (typeof CONTENT_EXCLUSIONS)[number];

export type PerformanceFormFactor = "desktop" | "mobile";

export interface TestRunOptions {
  /** Real form submissions (newsletter, contact). Off by default. */
  allowFormSubmission: boolean;
  maxLinksPerPage: number;
  navigationTimeoutMs: number;
  /** Phase 3 options; absent on runs created before Phase 3 (defaults apply). */
  typographyMode?: TypographyMode;
  content?: {
    mode: ContentComparisonMode;
    exclusions: ContentExclusion[];
    /** Extra CSS selectors removed before comparison. */
    customSelectors: string[];
  };
  performance?: {
    formFactors: PerformanceFormFactor[];
  };
  /** Report formats generated automatically when the run completes (none: generate on demand). */
  reports?: {
    formats: GeneratedReportFormat[];
  };
}

/** Report formats the report generator produces. EXCEL means both the testing and the bug workbook. */
export const GENERATED_REPORT_FORMATS = ["PDF", "HTML", "EXCEL"] as const;
export type GeneratedReportFormat = (typeof GENERATED_REPORT_FORMATS)[number];

export const DEFAULT_ADVANCED_OPTIONS: Required<Pick<TestRunOptions, "typographyMode" | "content" | "performance">> = {
  typographyMode: "TYPOGRAPHY_TAGS",
  content: { mode: "SECTION", exclusions: ["header", "footer", "navigation", "cookie", "ads", "recommendations", "dynamic"], customSelectors: [] },
  performance: { formFactors: ["desktop"] },
};

export function resolveRunOptions(options: TestRunOptions): Required<TestRunOptions> {
  return {
    ...options,
    typographyMode: options.typographyMode ?? DEFAULT_ADVANCED_OPTIONS.typographyMode,
    content: options.content ?? DEFAULT_ADVANCED_OPTIONS.content,
    performance: options.performance ?? DEFAULT_ADVANCED_OPTIONS.performance,
    reports: options.reports ?? { formats: [] },
  };
}

export interface TestRunDetail {
  id: string;
  projectId: string;
  projectName: string;
  name: string | null;
  status: TestRunStatus;
  configurationId: string | null;
  modules: string[];
  browsers: BrowserName[];
  viewports: string[];
  pageIds: string[];
  options: TestRunOptions;
  progressTotal: number;
  progressCompleted: number;
  currentPageUrl: string | null;
  currentTest: string | null;
  cancelRequested: boolean;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  counts: ResultStatusCounts;
}

export interface WorkerStatus {
  online: boolean;
  lastSeenAt: string | null;
  handlers: string[];
}
