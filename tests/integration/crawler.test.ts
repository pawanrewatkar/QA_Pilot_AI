import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebsiteCrawler, type CrawledPage } from "@/lib/crawler/crawler";
import { PlaywrightPageLoader } from "@/lib/crawler/playwright-loader";
import { startFixtureSite, type FixtureSite } from "../fixtures/site-server";
import { browserInstalled, INTEGRATION_TIMEOUT } from "./helpers";

describe.skipIf(!browserInstalled("chromium"))("crawler against a real site (Chromium)", () => {
  let site: FixtureSite;
  const pages = new Map<string, CrawledPage>();
  let summary: Awaited<ReturnType<WebsiteCrawler["crawl"]>>;

  beforeAll(async () => {
    site = await startFixtureSite();
    const loader = new PlaywrightPageLoader();
    const crawler = new WebsiteCrawler({ loader, politenessDelayMs: 0 });
    summary = await crawler.crawl(site.origin, { maxDepth: 3, maxPages: 60, timeoutMs: 15_000, retries: 0 }, {
      onPage: (p) => {
        pages.set(new URL(p.normalizedUrl).pathname + new URL(p.normalizedUrl).search, p);
      },
    });
    await loader.close();
  }, INTEGRATION_TIMEOUT);

  afterAll(async () => {
    await site?.close();
  });

  it("completes and discovers pages from navigation, content, pagination and the sitemap", () => {
    expect(summary.status).toBe("COMPLETED");
    for (const path of ["/", "/about", "/services", "/contact", "/blog", "/blog/post-1", "/pricing", "/faq", "/login", "/products/widget", "/blog?page=2"]) {
      expect(pages.get(path)?.crawlStatus, path).toBe("CRAWLED");
    }
    expect(pages.get("/hidden-from-nav")?.sources).toContain("robots-sitemap");
    expect(pages.get("/about")?.sources).toEqual(expect.arrayContaining(["navigation"]));
    expect(pages.get("/blog?page=2")?.sources).toContain("pagination");
    expect(pages.get("/pricing")?.sources).toContain("cta");
    expect(pages.get("/privacy")?.sources).toContain("footer");
  });

  it("deduplicates redirects and never visits unsafe or disallowed URLs", () => {
    const about = [...pages.values()].filter((p) => p.normalizedUrl.endsWith("/about"));
    expect(about).toHaveLength(1);
    expect(pages.get("/redirect-about")?.crawlStatus).toBe("SKIPPED");
    expect(pages.has("/logout")).toBe(false);
    expect(pages.get("/private")).toMatchObject({ crawlStatus: "SKIPPED", errorMessage: "Disallowed by robots.txt" });
    expect([...pages.keys()].some((k) => k.includes("localhost"))).toBe(false);
  });

  it("records failed pages without stopping the crawl", () => {
    expect(pages.get("/missing-page")).toMatchObject({ crawlStatus: "FAILED", httpStatus: 404 });
    expect(pages.get("/server-error")).toMatchObject({ crawlStatus: "FAILED", httpStatus: 500 });
    expect(summary.progress.failed).toBeGreaterThanOrEqual(2);
    expect(summary.progress.crawled).toBeGreaterThanOrEqual(11);
  });

  it("detects page types and names", () => {
    expect(pages.get("/")?.pageType).toBe("HOMEPAGE");
    expect(pages.get("/about")?.pageType).toBe("ABOUT");
    expect(pages.get("/contact")?.pageType).toBe("CONTACT");
    expect(pages.get("/login")?.pageType).toBe("LOGIN");
    expect(pages.get("/products/widget")?.pageType).toBe("PRODUCT_DETAIL");
    expect(pages.get("/faq")?.pageType).toBe("FAQ");
    expect(pages.get("/blog")?.pageType).toBe("BLOG_LISTING");
    expect(pages.get("/blog/post-1")?.pageType).toBe("BLOG_DETAIL");
    expect(pages.get("/pricing")?.pageType).toBe("PRICING");
    expect(pages.get("/about")?.name).toBe("About us");
    expect(pages.get("/about")?.description).toBe("About us page of the fixture site");
  });

  it("respects maxPages and maxDepth limits", async () => {
    const loader = new PlaywrightPageLoader();
    const seen: CrawledPage[] = [];
    const limited = await new WebsiteCrawler({ loader, politenessDelayMs: 0 }).crawl(site.origin, { maxDepth: 1, maxPages: 4, useSitemap: false, timeoutMs: 15_000 }, { onPage: (p) => void seen.push(p) });
    await loader.close();
    expect(limited.status).toBe("COMPLETED");
    expect(new Set(seen.map((p) => p.normalizedUrl)).size).toBeLessThanOrEqual(4);
    expect(Math.max(...seen.map((p) => p.depth))).toBeLessThanOrEqual(1);
  }, INTEGRATION_TIMEOUT);

  it("stops on cancellation", async () => {
    const loader = new PlaywrightPageLoader();
    let n = 0;
    const result = await new WebsiteCrawler({ loader, politenessDelayMs: 0 }).crawl(site.origin, { maxDepth: 3, maxPages: 50 }, { onPage: () => void n++, shouldCancel: () => n >= 2 });
    await loader.close();
    expect(result.status).toBe("CANCELLED");
  }, INTEGRATION_TIMEOUT);

  it("fails fast with a clear message for unreachable sites", async () => {
    const loader = new PlaywrightPageLoader();
    const result = await new WebsiteCrawler({ loader }).crawl("http://127.0.0.1:1", { timeoutMs: 5_000 }, { onPage: () => undefined });
    await loader.close();
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/not reachable/i);
  }, INTEGRATION_TIMEOUT);
});
