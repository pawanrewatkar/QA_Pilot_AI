import type { ReportFormat } from "./domain";

export const TEST_SCOPES = ["ENTIRE_WEBSITE", "SELECTED_PAGES", "MANUAL_URLS"] as const;
export type TestScope = (typeof TEST_SCOPES)[number];

export const BROWSERS = ["chromium", "firefox", "webkit"] as const;
export type BrowserName = (typeof BROWSERS)[number];

export type ViewportKind = "desktop" | "mobile";

export interface Viewport {
  id: string;
  kind: ViewportKind;
  width: number;
  height: number;
}

export interface ReportSections {
  executiveSummary: boolean;
  detailedResults: boolean;
  bugReport: boolean;
  evidence: boolean;
  performance: boolean;
  accessibility: boolean;
}

export interface TestConfiguration {
  id: string;
  projectId: string;
  name: string;
  scope: TestScope;
  selectedPageIds: string[];
  manualUrls: string[];
  modules: string[];
  browsers: BrowserName[];
  viewports: string[];
  reportFormats: ReportFormat[];
  reportSections: ReportSections;
  createdAt: string;
  updatedAt: string;
}

export type TestConfigurationInput = Omit<TestConfiguration, "id" | "createdAt" | "updatedAt">;
