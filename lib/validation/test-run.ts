import { z } from "zod";
import { ALL_TEST_MODULE_IDS, VIEWPORT_IDS } from "@/lib/constants/testing";
import { BROWSERS, GENERATED_REPORT_FORMATS, CONTENT_COMPARISON_MODES, CONTENT_EXCLUSIONS, DEFAULT_ADVANCED_OPTIONS, TYPOGRAPHY_MODES } from "@/types";

export const MAX_PAGES_PER_RUN = 200;

export const testRunFormSchema = z.object({
  projectId: z.string().min(1, "Choose a project."),
  configurationId: z.string().nullable(),
  name: z.string().trim().max(100, "Name must be at most 100 characters.").transform((v) => v || null),
  pageIds: z.array(z.string().min(1)).min(1, "Select at least one page.").max(MAX_PAGES_PER_RUN, `At most ${MAX_PAGES_PER_RUN} pages per run.`),
  modules: z
    .array(z.string())
    .min(1, "Select at least one testing module.")
    .refine((ids) => ids.every((id) => ALL_TEST_MODULE_IDS.includes(id)), "Unknown testing module selected."),
  browsers: z.array(z.enum(BROWSERS)).min(1, "Select at least one browser."),
  viewports: z
    .array(z.string())
    .min(1, "Select at least one viewport.")
    .refine((ids) => ids.every((id) => VIEWPORT_IDS.includes(id)), "Unknown viewport selected."),
  allowFormSubmission: z.boolean(),
  maxLinksPerPage: z.coerce.number().int().min(1).max(500),
  navigationTimeoutSeconds: z.coerce.number().int().min(5).max(120),
  typographyMode: z.enum(TYPOGRAPHY_MODES).default(DEFAULT_ADVANCED_OPTIONS.typographyMode),
  contentMode: z.enum(CONTENT_COMPARISON_MODES).default(DEFAULT_ADVANCED_OPTIONS.content.mode),
  contentExclusions: z.array(z.enum(CONTENT_EXCLUSIONS)).default([...DEFAULT_ADVANCED_OPTIONS.content.exclusions]),
  contentCustomSelectors: z
    .string()
    .max(2000)
    .default("")
    .transform((v) => v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20)),
  performanceFormFactors: z.array(z.enum(["desktop", "mobile"])).default(["desktop"]),
  reportFormats: z.array(z.enum(GENERATED_REPORT_FORMATS)).default([]),
});

export type TestRunForm = z.infer<typeof testRunFormSchema>;
export type TestRunFieldErrors = Partial<Record<keyof TestRunForm | "form", string>>;

export function parseTestRunForm(raw: unknown): { ok: true; data: TestRunForm } | { ok: false; errors: TestRunFieldErrors } {
  const parsed = testRunFormSchema.safeParse(raw);
  if (parsed.success) {
    const d = parsed.data;
    return {
      ok: true,
      data: {
        ...d,
        pageIds: [...new Set(d.pageIds)],
        modules: ALL_TEST_MODULE_IDS.filter((id) => d.modules.includes(id)),
        browsers: BROWSERS.filter((b) => d.browsers.includes(b)),
        viewports: VIEWPORT_IDS.filter((v) => d.viewports.includes(v)),
        reportFormats: GENERATED_REPORT_FORMATS.filter((f) => d.reportFormats.includes(f)),
      },
    };
  }
  const errors: TestRunFieldErrors = {};
  for (const issue of parsed.error.issues) errors[(issue.path[0] as keyof TestRunFieldErrors) ?? "form"] ??= issue.message;
  return { ok: false, errors };
}
