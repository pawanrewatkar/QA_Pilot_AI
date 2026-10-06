import type { AppEnv } from "@/lib/config/env";

/** Whether credentials / configuration exist for the integration. */
export type ProviderConfigState = "CONFIGURED" | "NOT_CONFIGURED" | "LOCAL";
/** Whether the integration's code is implemented in this build. */
export type ProviderAvailability = "ACTIVE" | "PLANNED";

export interface ProviderStatus {
  id: string;
  name: string;
  implementation: string;
  state: ProviderConfigState;
  availability: ProviderAvailability;
  detail: string;
  envKeys: string[];
}

/**
 * Describes each integration from environment configuration. Reports only whether a secret
 * is present, never its value.
 */
export function getProviderStatuses(env: AppEnv): ProviderStatus[] {
  const has = (v?: string) => typeof v === "string" && v.trim().length > 0;

  return [
    {
      id: "ai",
      name: "AI Provider",
      implementation: "LocalAnalysisProvider",
      state: "LOCAL",
      availability: "ACTIVE",
      detail:
        env.AI_PROVIDER === "anthropic" || has(env.ANTHROPIC_API_KEY)
          ? "An external AI key or provider was configured, but external AI is not enabled in this phase. Deterministic local analysis is used; no data leaves the machine."
          : "Deterministic, rule-based analysis. No network calls. AI suggestions never create test results or evidence.",
      envKeys: ["AI_PROVIDER", "ANTHROPIC_API_KEY"],
    },
    env.DATABASE_PROVIDER === "supabase"
      ? {
          id: "database",
          name: "Database",
          implementation: "SupabaseDatabaseProvider",
          state: has(env.SUPABASE_URL) && has(env.SUPABASE_SERVICE_ROLE_KEY) ? "CONFIGURED" : "NOT_CONFIGURED",
          availability: "PLANNED",
          detail: "Supabase support is not implemented yet. Set DATABASE_PROVIDER=local.",
          envKeys: ["DATABASE_PROVIDER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
        }
      : {
          id: "database",
          name: "Database",
          implementation: "LocalDatabaseProvider (SQLite)",
          state: "LOCAL",
          availability: "ACTIVE",
          detail: `SQLite file at ${env.DATABASE_PATH}.`,
          envKeys: ["DATABASE_PROVIDER", "DATABASE_PATH"],
        },
    {
      id: "storage",
      name: "Storage",
      implementation: "LocalStorageProvider (filesystem)",
      state: "LOCAL",
      availability: "ACTIVE",
      detail: `Documents, screenshots and reports stored under ${env.STORAGE_PATH}.`,
      envKeys: ["STORAGE_PROVIDER", "STORAGE_PATH", "MAX_UPLOAD_MB"],
    },
    {
      id: "figma",
      name: "Figma",
      implementation: "FigmaProvider (REST API)",
      state: has(env.FIGMA_ACCESS_TOKEN) ? "CONFIGURED" : "NOT_CONFIGURED",
      availability: "PLANNED",
      detail: has(env.FIGMA_ACCESS_TOKEN)
        ? "Access token detected. The Figma provider architecture is in place, but design comparison is not implemented yet; Figma checks report NOT EXECUTED."
        : "Not configured. Figma checks report NOT EXECUTED; no design values are ever invented. Project Figma URLs can be stored now.",
      envKeys: ["FIGMA_ACCESS_TOKEN"],
    },
    {
      id: "performance",
      name: "Performance",
      implementation: "LocalLighthouseProvider (fallback: browser timing)",
      state: "LOCAL",
      availability: "ACTIVE",
      detail: has(env.PAGESPEED_API_KEY)
        ? "Lighthouse runs locally against Playwright's Chromium. A PageSpeed key was detected, but the Google PageSpeed provider is not implemented yet and is never used for scores."
        : "Lighthouse runs locally against Playwright's Chromium (no API key). Results are labelled “Local Lighthouse”; a future Google PageSpeed provider will be labelled separately.",
      envKeys: ["PAGESPEED_API_KEY"],
    },
    {
      id: "accessibility",
      name: "Accessibility",
      implementation: "axe-core via @axe-core/playwright + keyboard focus probe",
      state: "LOCAL",
      availability: "ACTIVE",
      detail: "Automated WCAG 2.x A/AA and best-practice rules. Automated checks cover only part of WCAG and are not a compliance claim.",
      envKeys: [],
    },
    {
      id: "content",
      name: "Content comparison",
      implementation: "Local exact/section comparison (PDF, DOCX, Markdown, text)",
      state: "LOCAL",
      availability: "ACTIVE",
      detail: "Exact and section comparison work without AI. Semantic comparison needs an AI provider and is reported as NOT EXECUTED.",
      envKeys: [],
    },
    {
      id: "email",
      name: "Email",
      implementation: env.EMAIL_PROVIDER === "smtp" ? "SMTP EmailProvider" : "LocalOutboxEmailProvider",
      state: env.EMAIL_PROVIDER === "smtp" ? (has(env.SMTP_URL) ? "CONFIGURED" : "NOT_CONFIGURED") : "LOCAL",
      availability: env.EMAIL_PROVIDER === "smtp" ? "PLANNED" : "ACTIVE",
      detail:
        env.EMAIL_PROVIDER === "smtp"
          ? "SMTP delivery is not implemented yet."
          : "Messages are written to the local outbox folder in storage; nothing is sent externally.",
      envKeys: ["EMAIL_PROVIDER", "SMTP_URL"],
    },
    {
      id: "crawler",
      name: "Crawler",
      implementation: "WebsiteCrawler + PlaywrightPageLoader (worker)",
      state: "LOCAL",
      availability: "ACTIVE",
      detail: "Same-site discovery from navigation, header, footer, CTA, breadcrumb and pagination links, robots.txt and sitemap.xml. Runs in the worker process with headless Chromium.",
      envKeys: [],
    },
    {
      id: "testing",
      name: "Browser Testing Engine",
      implementation: "Playwright test engine (worker)",
      state: "LOCAL",
      availability: "ACTIVE",
      detail: "Executes link, navigation, component, form, search, console and network checks in Chromium, Firefox and WebKit. Browsers are installed locally with npm run browsers:install.",
      envKeys: [],
    },
  ];
}
