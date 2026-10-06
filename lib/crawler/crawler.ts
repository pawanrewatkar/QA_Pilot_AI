import { CRAWL_LIMITS, DEFAULT_CRAWL_CONFIG } from "@/lib/constants/crawl";
import { fetchUrl, CRAWLER_TOKEN, type HttpResult } from "@/lib/net/http";
import type { NavigationOutcome } from "@/lib/playwright/page-session";
import { normalizeWebsiteUrl } from "@/lib/validation/url";
import type { CrawlConfig, DiscoverySource, PageCrawlStatus, PageType } from "@/types";
import type { ExtractedPage } from "./extract";
import {
  compileExclusion,
  extensionOfPath,
  isInScope,
  isUnsafeToVisit,
  looksLikeCrawlTrap,
  NON_HTML_EXTENSIONS,
  normalizeCrawlUrl,
  UrlFrontier,
} from "./normalize";
import { derivePageName, detectPageType } from "./page-type";
import { ALLOW_ALL, parseRobotsTxt, type RobotsRules } from "./robots";
import { parseSitemap } from "./sitemap";

export { CRAWL_LIMITS, DEFAULT_CRAWL_CONFIG };

export interface PageLoadResult {
  navigation: NavigationOutcome;
  contentType: string | null;
  extracted: ExtractedPage | null;
}

/** Loads and inspects one URL. The production implementation drives a real browser. */
export interface PageLoader {
  load(url: string, timeoutMs: number): Promise<PageLoadResult>;
}

export interface CrawledPage {
  url: string;
  normalizedUrl: string;
  finalUrl: string | null;
  depth: number;
  sources: DiscoverySource[];
  crawlStatus: PageCrawlStatus;
  httpStatus: number | null;
  contentType: string | null;
  title: string | null;
  name: string;
  description: string | null;
  pageType: PageType;
  pageTypeConfidence: number | null;
  errorMessage: string | null;
}

export interface CrawlProgress {
  discovered: number;
  crawled: number;
  failed: number;
  skipped: number;
  currentUrl: string | null;
  currentDepth: number;
  maxDepthReached: number;
}

export interface CrawlHooks {
  onStart?(info: { resolvedStartUrl: string; robots: boolean; sitemapUrls: number }): void | Promise<void>;
  /** Called whenever a page is crawled, fails, is skipped, or gains a new discovery source. */
  onPage(page: CrawledPage): void | Promise<void>;
  onProgress?(progress: CrawlProgress): void | Promise<void>;
  shouldCancel?(): boolean | Promise<boolean>;
}

export interface CrawlSummary {
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  resolvedStartUrl: string | null;
  error: string | null;
  progress: CrawlProgress;
}

export interface CrawlerDeps {
  loader: PageLoader;
  http?: (url: string, options?: Parameters<typeof fetchUrl>[1]) => Promise<HttpResult>;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum delay between page loads, unless robots.txt asks for more (capped at 5s). */
  politenessDelayMs?: number;
}

interface FrontierEntry {
  depth: number;
}

const RETRYABLE = new Set(["TIMEOUT", "CONNECTION", "CRASH", "UNKNOWN"]);
const MAX_SITEMAP_DOCUMENTS = 10;

export function sanitizeCrawlConfig(input: Partial<CrawlConfig>): CrawlConfig {
  const c = { ...DEFAULT_CRAWL_CONFIG, ...input };
  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));
  return {
    ...c,
    maxDepth: clamp(c.maxDepth, 0, CRAWL_LIMITS.maxDepth),
    maxPages: clamp(c.maxPages, 1, CRAWL_LIMITS.maxPages),
    timeoutMs: clamp(c.timeoutMs, CRAWL_LIMITS.minTimeoutMs, CRAWL_LIMITS.maxTimeoutMs),
    retries: clamp(c.retries, 0, CRAWL_LIMITS.maxRetries),
    exclusions: c.exclusions.map((e) => e.trim()).filter(Boolean).slice(0, 50),
    // The engine never leaves the project's website; the flag exists for explicitness.
    sameDomainOnly: true,
  };
}

/**
 * Breadth-first website crawler.
 * - Starts at the project URL after validating, normalizing and confirming it is reachable.
 * - Follows redirects only within the site; an off-site redirect is reported, never followed.
 * - Discovers pages from layout links (header/nav/footer/CTA/breadcrumb/pagination/content),
 *   navigating buttons, robots.txt sitemaps and sitemap.xml.
 * - Deduplicates by normalized URL, bounds depth/page count, and skips traps, unsafe URLs,
 *   excluded patterns and robots-disallowed paths.
 * - A failing page is recorded and the crawl continues.
 */
export class WebsiteCrawler {
  private readonly http: NonNullable<CrawlerDeps["http"]>;
  private readonly sleep: NonNullable<CrawlerDeps["sleep"]>;

  constructor(private readonly deps: CrawlerDeps) {
    this.http = deps.http ?? fetchUrl;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async crawl(startUrlInput: string, rawConfig: Partial<CrawlConfig>, hooks: CrawlHooks): Promise<CrawlSummary> {
    const config = sanitizeCrawlConfig(rawConfig);
    const progress: CrawlProgress = { discovered: 0, crawled: 0, failed: 0, skipped: 0, currentUrl: null, currentDepth: 0, maxDepthReached: 0 };
    const fail = (error: string, resolved: string | null = null): CrawlSummary => ({ status: "FAILED", resolvedStartUrl: resolved, error, progress });

    // 1–2. Validate and normalize.
    const valid = normalizeWebsiteUrl(startUrlInput);
    if (!valid.ok) return fail(`Invalid website URL: ${valid.error}`);
    const normOpts = { queryParams: config.queryParams };
    const startUrl = normalizeCrawlUrl(valid.url, undefined, normOpts);
    if (!startUrl) return fail("Invalid website URL.");

    // 3–5. Reachability, with redirects followed only inside the site.
    const scopeRoot = startUrl;
    let offSiteRedirect: string | null = null;
    const reach = await this.http(startUrl, {
      timeoutMs: config.timeoutMs,
      allowRedirect: (_from, to) => {
        if (isInScope(scopeRoot, to, config.includeSubdomains)) return true;
        offSiteRedirect = to;
        return false;
      },
    });
    if (offSiteRedirect) return fail(`The website redirects to a different domain (${offSiteRedirect}). Crawling stopped to stay on the project's site.`);

    let resolvedStart = normalizeCrawlUrl(reach.finalUrl, undefined, normOpts) ?? startUrl;
    if (!reach.ok) {
      // Some servers reject non-browser clients; confirm with a real browser before giving up.
      const probe = await this.deps.loader.load(startUrl, config.timeoutMs);
      if (!probe.navigation.ok) {
        const reason = reach.error?.message ?? (reach.status ? `HTTP ${reach.status}` : probe.navigation.error?.message ?? "unreachable");
        return fail(`Website is not reachable: ${reason}`);
      }
      const finalFromBrowser = normalizeCrawlUrl(probe.navigation.finalUrl, undefined, normOpts);
      if (finalFromBrowser && !isInScope(scopeRoot, finalFromBrowser, config.includeSubdomains)) {
        return fail(`The website redirects to a different domain (${finalFromBrowser}). Crawling stopped to stay on the project's site.`);
      }
      resolvedStart = finalFromBrowser ?? resolvedStart;
    }
    const origin = new URL(resolvedStart).origin;
    const inScope = (u: string) => isInScope(resolvedStart, u, config.includeSubdomains);

    // robots.txt
    let robots: RobotsRules = ALLOW_ALL;
    let robotsFound = false;
    const robotsRes = await this.http(`${origin}/robots.txt`, { readBody: true, timeoutMs: 10_000, maxBodyBytes: 512 * 1024, allowRedirect: (_f, to) => inScope(to) });
    if (robotsRes.ok && robotsRes.body && !/text\/html/i.test(robotsRes.contentType ?? "")) {
      robots = parseRobotsTxt(robotsRes.body, CRAWLER_TOKEN);
      robotsFound = true;
    }
    const robotsAllows = (u: string) => {
      if (!config.respectRobotsTxt) return true;
      const p = new URL(u);
      return robots.isAllowed(`${p.pathname}${p.search}`);
    };
    const delayMs = Math.min(5_000, Math.max(this.deps.politenessDelayMs ?? 200, (robots.crawlDelaySeconds ?? 0) * 1000));

    const exclusions = config.exclusions.map(compileExclusion);
    const isExcluded = (u: string) => {
      const p = new URL(u);
      return exclusions.some((m) => m(`${p.pathname}${p.search}`));
    };

    const frontier = new UrlFrontier<FrontierEntry>();
    const sources = new Map<string, Set<DiscoverySource>>();
    const emitted = new Map<string, CrawledPage>();
    let registered = 0;

    const addSource = async (url: string, source: DiscoverySource) => {
      const set = sources.get(url) ?? new Set();
      const isNew = !set.has(source);
      set.add(source);
      sources.set(url, set);
      const page = emitted.get(url);
      if (isNew && page) {
        page.sources = [...set];
        await hooks.onPage({ ...page });
      }
    };

    /** Returns true if the URL was queued (or is already known). */
    const enqueue = async (rawUrl: string, depth: number, source: DiscoverySource): Promise<boolean> => {
      const url = normalizeCrawlUrl(rawUrl, undefined, normOpts);
      if (!url || !inScope(url)) return false;
      if (frontier.has(url)) {
        await addSource(url, source);
        return true;
      }
      const ext = extensionOfPath(new URL(url).pathname);
      if (NON_HTML_EXTENSIONS.has(ext) || isUnsafeToVisit(url) || looksLikeCrawlTrap(url) || isExcluded(url)) {
        frontier.markSeen(url);
        progress.skipped++;
        return false;
      }
      if (depth > config.maxDepth) return false;
      if (registered >= config.maxPages) {
        frontier.markSeen(url);
        progress.skipped++;
        return false;
      }
      registered++;
      progress.discovered = registered;
      frontier.add(url, { depth });
      await addSource(url, source);
      return true;
    };

    await enqueue(resolvedStart, 0, "start");

    // Sitemaps (robots-declared first, then the conventional location).
    let sitemapUrls = 0;
    if (config.useSitemap) {
      const queue: { url: string; source: DiscoverySource }[] = [
        ...robots.sitemaps.map((url) => ({ url, source: "robots-sitemap" as const })),
        { url: `${origin}/sitemap.xml`, source: "sitemap" },
      ];
      const fetched = new Set<string>();
      while (queue.length && fetched.size < MAX_SITEMAP_DOCUMENTS && registered < config.maxPages) {
        const item = queue.shift()!;
        if (fetched.has(item.url) || !inScope(item.url)) continue;
        fetched.add(item.url);
        const res = await this.http(item.url, { readBody: true, timeoutMs: 15_000, maxBodyBytes: 10 * 1024 * 1024, allowRedirect: (_f, to) => inScope(to) });
        if (!res.ok || !res.body || !/<(urlset|sitemapindex)\b/i.test(res.body)) continue;
        const parsed = parseSitemap(res.body);
        for (const nested of parsed.sitemaps) queue.push({ url: nested, source: item.source });
        for (const u of parsed.urls) {
          if (registered >= config.maxPages) break;
          if (await enqueue(u, Math.min(1, config.maxDepth), item.source)) sitemapUrls++;
        }
      }
    }

    await hooks.onStart?.({ resolvedStartUrl: resolvedStart, robots: robotsFound, sitemapUrls });
    await hooks.onProgress?.({ ...progress });

    const emit = async (page: CrawledPage) => {
      page.sources = [...(sources.get(page.normalizedUrl) ?? new Set<DiscoverySource>())];
      emitted.set(page.normalizedUrl, page);
      await hooks.onPage({ ...page });
    };

    const blank = (url: string, depth: number): CrawledPage => ({
      url,
      normalizedUrl: url,
      finalUrl: null,
      depth,
      sources: [],
      crawlStatus: "DISCOVERED",
      httpStatus: null,
      contentType: null,
      title: null,
      name: derivePageName("", "", url),
      description: null,
      pageType: "OTHER",
      pageTypeConfidence: null,
      errorMessage: null,
    });

    let first = true;
    for (let entry = frontier.next(); entry; entry = frontier.next()) {
      if (await hooks.shouldCancel?.()) return { status: "CANCELLED", resolvedStartUrl: resolvedStart, error: null, progress };
      const { url, data } = entry;
      progress.currentUrl = url;
      progress.currentDepth = data.depth;
      progress.maxDepthReached = Math.max(progress.maxDepthReached, data.depth);
      await hooks.onProgress?.({ ...progress });

      if (!robotsAllows(url)) {
        progress.skipped++;
        await emit({ ...blank(url, data.depth), crawlStatus: "SKIPPED", errorMessage: "Disallowed by robots.txt" });
        continue;
      }

      if (!first) await this.sleep(delayMs);
      first = false;

      let result: PageLoadResult | null = null;
      for (let attempt = 0; attempt <= config.retries; attempt++) {
        result = await this.deps.loader.load(url, config.timeoutMs);
        if (result.navigation.ok || !result.navigation.error || !RETRYABLE.has(result.navigation.error.kind)) break;
      }
      const nav = result!.navigation;
      const page = blank(url, data.depth);
      page.httpStatus = nav.status;
      page.contentType = result!.contentType;

      if (!nav.ok) {
        progress.failed++;
        await emit({ ...page, crawlStatus: "FAILED", errorMessage: nav.error?.message ?? `HTTP ${nav.status}` });
        continue;
      }

      const finalNorm = normalizeCrawlUrl(nav.finalUrl, undefined, normOpts);
      if (finalNorm && finalNorm !== url) {
        page.finalUrl = finalNorm;
        if (!inScope(finalNorm)) {
          progress.skipped++;
          await emit({ ...page, crawlStatus: "SKIPPED", errorMessage: `Redirects off-site to ${finalNorm}` });
          continue;
        }
        if (frontier.has(finalNorm) && finalNorm !== url) {
          // Alias of a page that is (or will be) crawled under its canonical address.
          progress.skipped++;
          await addSource(finalNorm, "redirect");
          await emit({ ...page, crawlStatus: "SKIPPED", errorMessage: `Redirects to ${finalNorm} (duplicate)` });
          continue;
        }
        frontier.markSeen(finalNorm);
      }

      if (result!.contentType && !/html|xml/i.test(result!.contentType)) {
        progress.skipped++;
        await emit({ ...page, crawlStatus: "SKIPPED", errorMessage: `Not an HTML page (${result!.contentType})` });
        continue;
      }

      const ex = result!.extracted;
      if (!ex) {
        progress.failed++;
        await emit({ ...page, crawlStatus: "FAILED", errorMessage: "Page loaded but could not be inspected" });
        continue;
      }

      const effectiveUrl = page.finalUrl ?? url;
      const typed = detectPageType({ ...ex.signals, url: effectiveUrl, isRoot: data.depth === 0 && new URL(effectiveUrl).pathname === "/" });
      progress.crawled++;
      await emit({
        ...page,
        crawlStatus: "CRAWLED",
        title: ex.title || null,
        name: derivePageName(ex.title, ex.h1, effectiveUrl),
        description: ex.metaDescription || null,
        pageType: typed.type,
        pageTypeConfidence: typed.confidence,
      });

      if (data.depth >= config.maxDepth) continue;
      for (const link of ex.links) {
        if (!link.href || link.download) continue;
        await enqueue(link.href, data.depth + 1, link.source);
      }
      await hooks.onProgress?.({ ...progress });
    }

    progress.currentUrl = null;
    await hooks.onProgress?.({ ...progress });
    return { status: "COMPLETED", resolvedStartUrl: resolvedStart, error: null, progress };
  }
}
