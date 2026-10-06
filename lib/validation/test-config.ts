import { z } from "zod";
import { ALL_TEST_MODULE_IDS, MAX_MANUAL_URLS, VIEWPORT_IDS } from "@/lib/constants/testing";
import { BROWSERS, REPORT_FORMATS, TEST_SCOPES, type TestConfigurationInput } from "@/types";
import { isSameSite, normalizeWebsiteUrl } from "./url";

const reportSectionsSchema = z.object({
  executiveSummary: z.boolean(),
  detailedResults: z.boolean(),
  bugReport: z.boolean(),
  evidence: z.boolean(),
  performance: z.boolean(),
  accessibility: z.boolean(),
});

/** Raw shape submitted by the configuration form (JSON-encoded). */
export const testConfigurationFormSchema = z.object({
  name: z.string().trim().min(1, "Configuration name is required.").max(100, "Name must be at most 100 characters."),
  scope: z.enum(TEST_SCOPES),
  selectedPageIds: z.array(z.string().min(1)).max(1000),
  manualUrls: z.string().max(MAX_MANUAL_URLS * 2100),
  modules: z
    .array(z.string())
    .min(1, "Select at least one testing module.")
    .refine((ids) => ids.every((id) => ALL_TEST_MODULE_IDS.includes(id)), "Unknown testing module selected."),
  browsers: z.array(z.enum(BROWSERS)).min(1, "Select at least one browser."),
  viewports: z
    .array(z.string())
    .min(1, "Select at least one viewport.")
    .refine((ids) => ids.every((id) => VIEWPORT_IDS.includes(id)), "Unknown viewport selected."),
  reportFormats: z.array(z.enum(REPORT_FORMATS)),
  reportSections: reportSectionsSchema,
});

export type TestConfigurationForm = z.infer<typeof testConfigurationFormSchema>;
export type TestConfigFieldErrors = Partial<Record<keyof TestConfigurationForm | "form", string>>;

/** Splits a newline/comma separated list of URLs, normalizes each and checks it belongs to the project site. */
export function parseManualUrls(text: string, projectUrl: string): { urls: string[]; errors: string[] } {
  const entries = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const urls: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const result = normalizeWebsiteUrl(entry);
    if (!result.ok) {
      errors.push(`${entry}: ${result.error}`);
      continue;
    }
    if (!isSameSite(projectUrl, result.url)) {
      errors.push(`${entry}: must be on the project website (${new URL(projectUrl).hostname}).`);
      continue;
    }
    if (!seen.has(result.url)) {
      seen.add(result.url);
      urls.push(result.url);
    }
  }
  if (urls.length > MAX_MANUAL_URLS) errors.push(`At most ${MAX_MANUAL_URLS} URLs are allowed.`);
  return { urls, errors };
}

/**
 * Validates a submitted configuration for a project. Distinct dedupe of modules/browsers/viewports
 * keeps stored configurations canonical.
 */
export function parseTestConfiguration(
  raw: unknown,
  project: { id: string; websiteUrl: string },
  knownPageIds: ReadonlySet<string>,
): { ok: true; data: TestConfigurationInput } | { ok: false; errors: TestConfigFieldErrors } {
  const parsed = testConfigurationFormSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: TestConfigFieldErrors = {};
    for (const issue of parsed.error.issues) {
      const key = (issue.path[0] as keyof TestConfigurationForm | undefined) ?? "form";
      errors[key] ??= issue.message;
    }
    return { ok: false, errors };
  }

  const form = parsed.data;
  const errors: TestConfigFieldErrors = {};
  let manualUrls: string[] = [];
  let selectedPageIds: string[] = [];

  if (form.scope === "MANUAL_URLS") {
    const result = parseManualUrls(form.manualUrls, project.websiteUrl);
    if (result.errors.length) errors.manualUrls = result.errors.slice(0, 5).join("\n");
    else if (result.urls.length === 0) errors.manualUrls = "Enter at least one URL.";
    manualUrls = result.urls;
  }

  if (form.scope === "SELECTED_PAGES") {
    selectedPageIds = [...new Set(form.selectedPageIds)];
    if (selectedPageIds.length === 0) errors.selectedPageIds = "Select at least one page.";
    else if (selectedPageIds.some((id) => !knownPageIds.has(id))) {
      errors.selectedPageIds = "One or more selected pages no longer exist for this project.";
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      projectId: project.id,
      name: form.name,
      scope: form.scope,
      selectedPageIds,
      manualUrls,
      modules: ALL_TEST_MODULE_IDS.filter((id) => form.modules.includes(id)),
      browsers: BROWSERS.filter((b) => form.browsers.includes(b)),
      viewports: VIEWPORT_IDS.filter((v) => form.viewports.includes(v)),
      reportFormats: REPORT_FORMATS.filter((f) => form.reportFormats.includes(f)),
      reportSections: form.reportSections,
    },
  };
}
