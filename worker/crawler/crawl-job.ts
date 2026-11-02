import { WebsiteCrawler, type PageLoader } from "@/lib/crawler/crawler";
import { PlaywrightPageLoader } from "@/lib/crawler/playwright-loader";
import type { EngineStore } from "@/lib/database/local/engine-store";

export interface CrawlJobDeps {
  store: EngineStore;
  log: (message: string) => void;
  signal?: AbortSignal;
  /** Overridable for tests. */
  loader?: PageLoader & { close?: () => Promise<void> };
}

/** Runs one crawl_runs record to completion, persisting pages and progress as it goes. */
export async function executeCrawl(crawlRunId: string, deps: CrawlJobDeps) {
  const { store, log } = deps;
  const crawl = await store.getCrawlRun(crawlRunId);
  if (!crawl) throw new Error(`Crawl run ${crawlRunId} not found`);
  if (crawl.status !== "PENDING") {
    log(`Crawl ${crawlRunId} is ${crawl.status}; skipping`);
    return;
  }
  await store.markCrawlRunning(crawlRunId);
  const loader = deps.loader ?? new PlaywrightPageLoader();
  const crawler = new WebsiteCrawler({ loader });
  let lastProgressWrite = 0;
  try {
    // The crawler awaits each hook, so every write completes before the crawl continues.
    const summary = await crawler.crawl(crawl.startUrl, crawl.config, {
      onStart: async ({ resolvedStartUrl, robots, sitemapUrls }) => {
        await store.setCrawlResolvedUrl(crawlRunId, resolvedStartUrl);
        log(`Crawl ${crawlRunId}: start ${resolvedStartUrl} (robots.txt ${robots ? "found" : "not found"}, ${sitemapUrls} sitemap URLs)`);
      },
      onPage: async (page) => {
        await store.upsertCrawledPage(crawl.projectId, crawlRunId, page);
      },
      onProgress: async (p) => {
        // Throttle writes; the UI polls about once per second.
        const t = Date.now();
        if (t - lastProgressWrite > 300 || p.currentUrl === null) {
          lastProgressWrite = t;
          await store.updateCrawlProgress(crawlRunId, p);
        }
      },
      shouldCancel: async () => !!deps.signal?.aborted || (await store.isCrawlCancelRequested(crawlRunId)),
    });
    await store.updateCrawlProgress(crawlRunId, summary.progress);
    await store.finishCrawl(crawlRunId, summary.status, summary.error);
    const p = summary.progress;
    await store.recordActivity(
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
    await store.finishCrawl(crawlRunId, "FAILED", message);
    await store.recordActivity(crawl.projectId, "crawl", crawlRunId, "failed", `Crawl failed: ${message.slice(0, 200)}`);
    throw error;
  } finally {
    await loader.close?.();
  }
}
