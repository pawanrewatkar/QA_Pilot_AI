/**
 * Page discovery contract. The Playwright/HTTP crawler that implements this runs in the
 * separate worker process (worker/crawler), never inside a serverless request.
 */
export interface CrawlerProvider {
  readonly id: string;
  crawl(request: CrawlRequest, signal?: AbortSignal): AsyncIterable<CrawlEvent>;
}

export interface CrawlRequest {
  projectId: string;
  startUrl: string;
  /** Hostnames the crawler may visit. Defaults to the start URL's hostname. */
  allowedHosts?: string[];
  maxPages: number;
  maxDepth: number;
  respectRobotsTxt: boolean;
  useSitemap: boolean;
  /** Minimum delay between requests to the same host, in milliseconds. */
  politenessDelayMs: number;
}

export type CrawlEvent =
  | { type: "page"; page: DiscoveredPage }
  | { type: "skipped"; url: string; reason: string }
  | { type: "error"; url: string; message: string }
  | { type: "done"; discovered: number };

export interface DiscoveredPage {
  url: string;
  normalizedUrl: string;
  title: string | null;
  httpStatus: number;
  depth: number;
  discoveredVia: "CRAWL" | "SITEMAP" | "MANUAL";
}

export const DEFAULT_CRAWL_LIMITS = {
  maxPages: 200,
  maxDepth: 4,
  politenessDelayMs: 250,
} as const;
