import { z } from "zod";
import { CRAWL_LIMITS, DEFAULT_CRAWL_CONFIG } from "@/lib/constants/crawl";
import type { CrawlConfig } from "@/types";

/** HTML checkboxes submit "on" when checked and nothing when unchecked. */
const checkbox = z.unknown().optional().transform((v) => v === "on" || v === "true" || v === true);

export const crawlConfigFormSchema = z.object({
  maxDepth: z.coerce.number().int().min(0, "Depth cannot be negative.").max(CRAWL_LIMITS.maxDepth, `Maximum depth is ${CRAWL_LIMITS.maxDepth}.`),
  maxPages: z.coerce.number().int().min(1, "Crawl at least 1 page.").max(CRAWL_LIMITS.maxPages, `Maximum is ${CRAWL_LIMITS.maxPages} pages.`),
  timeoutSeconds: z.coerce.number().int().min(CRAWL_LIMITS.minTimeoutMs / 1000, `Timeout must be at least ${CRAWL_LIMITS.minTimeoutMs / 1000}s.`).max(CRAWL_LIMITS.maxTimeoutMs / 1000, `Timeout must be at most ${CRAWL_LIMITS.maxTimeoutMs / 1000}s.`),
  retries: z.coerce.number().int().min(0).max(CRAWL_LIMITS.maxRetries, `At most ${CRAWL_LIMITS.maxRetries} retries.`),
  exclusions: z.string().max(5000).nullish().transform((v) => v ?? ""),
  includeSubdomains: checkbox,
  respectRobotsTxt: checkbox,
  useSitemap: checkbox,
  queryParams: z.enum(["keep", "strip-tracking", "strip-all"]),
});

export type CrawlFieldErrors = Partial<Record<keyof z.infer<typeof crawlConfigFormSchema> | "form", string>>;

export function parseCrawlConfig(raw: Record<string, unknown>): { ok: true; config: CrawlConfig } | { ok: false; errors: CrawlFieldErrors } {
  const parsed = crawlConfigFormSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: CrawlFieldErrors = {};
    for (const issue of parsed.error.issues) errors[(issue.path[0] as keyof CrawlFieldErrors) ?? "form"] ??= issue.message;
    return { ok: false, errors };
  }
  const v = parsed.data;
  return {
    ok: true,
    config: {
      ...DEFAULT_CRAWL_CONFIG,
      maxDepth: v.maxDepth,
      maxPages: v.maxPages,
      timeoutMs: v.timeoutSeconds * 1000,
      retries: v.retries,
      exclusions: v.exclusions
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 50),
      sameDomainOnly: true,
      includeSubdomains: v.includeSubdomains,
      respectRobotsTxt: v.respectRobotsTxt,
      useSitemap: v.useSitemap,
      queryParams: v.queryParams,
    },
  };
}
