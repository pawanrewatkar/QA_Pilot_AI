import { WebsiteCrawler, type PageLoader } from "@/lib/crawler/crawler";
import { PlaywrightPageLoader } from "@/lib/crawler/playwright-loader";
import type { SqliteEngineStore } from "@/lib/database/local/engine-store";

export interface CrawlJobDeps {
  store: SqliteEngineStore;
  log: (message: string) => void;
  signal?: AbortSignal;
  /** Overridable for tests. */
  loader?: PageLoader & { close?: () => Promise<void> };
}

/** Runs one crawl_runs record to completion, persisting pages and progress as it goes. */
export async function executeCrawl(crawlRunId: string, deps: CrawlJobDeps) {
  const { store, log } = deps;
  const crawl = store.getCrawlRun(crawlRunId);
  if (!crawl) throw new Error(`Crawl run ${crawlRunId} not found`);
  if (crawl.status !== "PENDING") {
    log(`Crawl ${crawlRunId} is ${crawl.status}; skipping`);
    return;
  }
  store.markCrawlRunning(crawlRunId);
  const loader = deps.loader ?? new PlaywrightPageLoader();
  const crawler = new WebsiteCrawler({ loader });
  let lastProgressWrite = 0;
  try {
    const summary = await crawler.crawl(crawl.startUrl, crawl.config, {
      onStart: ({ resolvedStartUrl, robots, sitemapUrls }) => {
        store.setCrawlResolvedUrl(crawlRunId, resolvedStartUrl);
        log(`Crawl ${crawlRunId}: start ${resolvedStartUrl} (robots.txt ${robots ? "found" : "not found"}, ${sitemapUrls} sitemap URLs)`);
      },
      onPage: (page) => {
        store.upsertCrawledPage(crawl.projectId, crawlRunId, page);
      },
      onProgress: (p) => {
        // Throttle writes; the UI polls about once per second.
        const t = Date.now();
        if (t - lastProgressWrite > 300 || p.currentUrl === null) {
          lastProgressWrite = t;
          store.updateCrawlProgress(crawlRunId, p);
        }
      },
      shouldCancel: () => !!deps.signal?.aborted || store.isCrawlCancelRequested(crawlRunId),
    });
    store.updateCrawlProgress(crawlRunId, summary.progress);
    store.finishCrawl(crawlRunId, summary.status, summary.error);
    const p = summary.progress;
    store.recordActivity(
      crawl.projectId,
      "crawl",
      crawlRunId,
      summary.status.toLowerCase(),
      summary.status === "FAILED"
        ? `Crawl failed: ${summary.error}`
        : `Crawl ${summary.status === "CANCELLED" ? "cancelled" : "completed"}: ${p.crawled} pages crawled, ${p.failed} failed, ${p.skipped} skipped`,
    );
    log(`Crawl ${crawlRunId} ${summary.status}: ${p.crawled} crawled, ${p.failed} failed, ${p.skipped} skipped`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.finishCrawl(crawlRunId, "FAILED", message);
    store.recordActivity(crawl.projectId, "crawl", crawlRunId, "failed", `Crawl failed: ${message.slice(0, 200)}`);
    throw error;
  } finally {
    await loader.close?.();
  }
}
