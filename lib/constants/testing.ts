import type { BrowserName, ReportFormat, ReportSections, TestScope, Viewport } from "@/types";

/** Project inputs a module needs before it can produce meaningful results. */
export type ModuleRequirement = "figmaUrl" | "referenceDocument" | "testEmail" | "testCredentials";

export interface TestModuleDefinition {
  id: string;
  label: string;
  description: string;
  requires?: ModuleRequirement[];
}

export interface TestModuleGroup {
  id: string;
  label: string;
  modules: TestModuleDefinition[];
}

export const TEST_MODULE_GROUPS: TestModuleGroup[] = [
  {
    id: "core",
    label: "Core Testing",
    modules: [
      { id: "ui", label: "UI Testing", description: "Layout, visibility, overlap and visual integrity of page elements." },
      { id: "functional", label: "Functional Testing", description: "Interactive features behave as intended." },
      { id: "positive", label: "Positive Testing", description: "Valid inputs and expected user flows succeed." },
      { id: "negative", label: "Negative Testing", description: "Invalid inputs are rejected with clear feedback." },
      { id: "edge", label: "Edge Testing", description: "Unusual but valid inputs and states." },
      { id: "boundary", label: "Boundary Testing", description: "Minimum, maximum and off-by-one input limits." },
    ],
  },
  {
    id: "navigation",
    label: "Links & Navigation",
    modules: [
      { id: "links", label: "Link Testing", description: "Broken links, redirects and HTTP status codes." },
      { id: "navigation", label: "Navigation Testing", description: "Menus, headers, footers and route transitions." },
      { id: "breadcrumb", label: "Breadcrumb Testing", description: "Breadcrumb trails reflect page hierarchy." },
      { id: "pagination", label: "Pagination Testing", description: "Page controls, boundaries and result consistency." },
      { id: "social-links", label: "Social Link Testing", description: "Social profile links resolve and open correctly." },
      { id: "downloads", label: "Download Testing", description: "Downloadable files are reachable and valid." },
    ],
  },
  {
    id: "forms",
    label: "Forms & Input",
    modules: [
      { id: "forms", label: "Form Testing", description: "Validation, required fields and submission handling." },
      { id: "newsletter", label: "Newsletter Testing", description: "Subscription form validation and confirmation.", requires: ["testEmail"] },
      { id: "search", label: "Search Testing", description: "Search queries, empty results and special characters." },
      { id: "filters", label: "Filter Testing", description: "Filters narrow results correctly and can be reset." },
      { id: "dropdowns", label: "Dropdown Testing", description: "Select menus open, close and apply values." },
      { id: "login", label: "Login Testing", description: "Authentication with valid and invalid credentials.", requires: ["testCredentials"] },
      { id: "logout", label: "Logout Testing", description: "Session termination and protected-route access.", requires: ["testCredentials"] },
    ],
  },
  {
    id: "components",
    label: "Interactive Components",
    modules: [
      { id: "tabs", label: "Tabs Testing", description: "Tab switching, keyboard support and panel content." },
      { id: "accordion", label: "Accordion Testing", description: "Expand/collapse behaviour and state." },
      { id: "modals", label: "Modal Testing", description: "Open/close, focus trapping and escape handling." },
      { id: "carousel", label: "Slider/Carousel Testing", description: "Slide controls, autoplay and indicators." },
      { id: "ecommerce", label: "Ecommerce Testing", description: "Product listing, cart and checkout entry points." },
    ],
  },
  {
    id: "quality",
    label: "Quality & Compliance",
    modules: [
      { id: "performance", label: "Performance Testing", description: "Load timings and Core Web Vitals measured in-browser." },
      { id: "accessibility", label: "Accessibility Testing", description: "WCAG rule violations detected on the rendered page." },
      { id: "seo", label: "SEO Testing", description: "Titles, meta descriptions, headings, canonical and indexability." },
      { id: "responsive", label: "Responsive Testing", description: "Layout behaviour across the selected viewports." },
      { id: "console", label: "Console Testing", description: "JavaScript errors and warnings in the browser console." },
      { id: "network", label: "Network Testing", description: "Failed requests, slow resources and mixed content." },
    ],
  },
  {
    id: "content",
    label: "Content & Design",
    modules: [
      { id: "content", label: "Content Testing", description: "Page content compared against the reference document.", requires: ["referenceDocument"] },
      { id: "figma", label: "Figma Testing", description: "Rendered UI compared against the Figma design.", requires: ["figmaUrl"] },
      { id: "typography", label: "Typography Testing", description: "Font families, sizes, weights and line heights." },
    ],
  },
];

export const ALL_TEST_MODULES: TestModuleDefinition[] = TEST_MODULE_GROUPS.flatMap((g) => g.modules);
export const ALL_TEST_MODULE_IDS: string[] = ALL_TEST_MODULES.map((m) => m.id);

export function getTestModule(id: string): TestModuleDefinition | undefined {
  return ALL_TEST_MODULES.find((m) => m.id === id);
}

export const MODULE_REQUIREMENT_LABELS: Record<ModuleRequirement, string> = {
  figmaUrl: "Figma URL on the project",
  referenceDocument: "Reference document on the project",
  testEmail: "Test email on the project",
  testCredentials: "Stored test credentials",
};

export const TEST_SCOPE_OPTIONS: { id: TestScope; label: string; description: string }[] = [
  { id: "ENTIRE_WEBSITE", label: "Entire Website", description: "Crawl from the project URL and test every discovered page." },
  { id: "SELECTED_PAGES", label: "Selected Pages", description: "Test only pages already discovered for this project." },
  { id: "MANUAL_URLS", label: "Manual URLs", description: "Test an explicit list of URLs on the project's website." },
];

export const BROWSER_OPTIONS: { id: BrowserName; label: string }[] = [
  { id: "chromium", label: "Chromium" },
  { id: "firefox", label: "Firefox" },
  { id: "webkit", label: "WebKit" },
];

export const VIEWPORTS: Viewport[] = [
  { id: "desktop-1920x1080", kind: "desktop", width: 1920, height: 1080 },
  { id: "desktop-1440x900", kind: "desktop", width: 1440, height: 900 },
  { id: "desktop-1366x768", kind: "desktop", width: 1366, height: 768 },
  { id: "mobile-390x844", kind: "mobile", width: 390, height: 844 },
  { id: "mobile-375x812", kind: "mobile", width: 375, height: 812 },
  { id: "mobile-412x915", kind: "mobile", width: 412, height: 915 },
];
export const VIEWPORT_IDS = VIEWPORTS.map((v) => v.id);

export const REPORT_FORMAT_OPTIONS: { id: ReportFormat; label: string; description: string }[] = [
  { id: "EXCEL", label: "Excel workbook", description: "Test cases, results and bugs as sheets (.xlsx)." },
  { id: "PDF", label: "PDF report", description: "Branded, printable summary report." },
  { id: "HTML", label: "HTML report", description: "Self-contained report viewable in a browser." },
  { id: "JSON", label: "JSON export", description: "Machine-readable raw results." },
  { id: "CSV", label: "CSV export", description: "Flat results table for spreadsheets." },
];

export const REPORT_SECTION_OPTIONS: { id: keyof ReportSections; label: string }[] = [
  { id: "executiveSummary", label: "Executive summary" },
  { id: "detailedResults", label: "Detailed test results" },
  { id: "bugReport", label: "Bug report" },
  { id: "evidence", label: "Screenshots & evidence" },
  { id: "performance", label: "Performance metrics" },
  { id: "accessibility", label: "Accessibility findings" },
];

export const DEFAULT_REPORT_SECTIONS: ReportSections = {
  executiveSummary: true,
  detailedResults: true,
  bugReport: true,
  evidence: true,
  performance: false,
  accessibility: false,
};

/**
 * Modules with a real implementation in the current engine. Kept here (not derived from the
 * engine registry) so client components never import browser-automation code; a unit test
 * asserts the two lists match.
 */
export const IMPLEMENTED_MODULE_IDS: readonly string[] = [
  "links", "social-links", "downloads", "console", "network", "navigation", "functional", "dropdowns", "tabs", "accordion",
  "modals", "carousel", "search", "filters", "pagination", "breadcrumb", "forms", "newsletter", "login", "logout",
  "ui", "typography", "accessibility", "seo", "content", "responsive", "ecommerce", "figma", "performance",
  // Scenario modules select positive/negative/edge/boundary cases across the feature modules above.
  "positive", "negative", "edge", "boundary",
];

/** Hard cap on manual URLs per configuration to keep runs bounded. */
export const MAX_MANUAL_URLS = 200;
