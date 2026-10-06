import type { CrawlConfig } from "@/types";

export const DEFAULT_CRAWL_CONFIG: CrawlConfig = {
  maxDepth: 3,
  maxPages: 100,
  timeoutMs: 30_000,
  retries: 1,
  exclusions: [],
  sameDomainOnly: true,
  includeSubdomains: false,
  respectRobotsTxt: true,
  useSitemap: true,
  queryParams: "strip-tracking",
};

export const CRAWL_LIMITS = { maxDepth: 10, maxPages: 2000, minTimeoutMs: 5_000, maxTimeoutMs: 120_000, maxRetries: 3 } as const;
