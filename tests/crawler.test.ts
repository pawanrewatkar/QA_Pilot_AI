import { describe, expect, it } from "vitest";
import { WebsiteCrawler, type CrawledPage, type PageLoader, type PageLoadResult } from "@/lib/crawler/crawler";
import type { ExtractedPage } from "@/lib/crawler/extract";
import { compileExclusion, isInScope, isUnsafeToVisit, looksLikeCrawlTrap, normalizeCrawlUrl, UrlFrontier } from "@/lib/crawler/normalize";
import { derivePageName, detectPageType, type PageSignals } from "@/lib/crawler/page-type";
import { parseRobotsTxt } from "@/lib/crawler/robots";
import { parseSitemap } from "@/lib/crawler/sitemap";
import type { HttpResult } from "@/lib/net/http";
import type { DiscoverySource } from "@/types";

describe("normalizeCrawlUrl", () => {
  it.each([
    ["https://Example.COM:443/About/#team", "https://example.com/About"],
    ["http://example.com:80/", "http://example.com/"],
    ["https://example.com/blog/", "https://example.com/blog"],
    ["https://example.com//a///b/", "https://example.com/a/b"],
    ["https://example.com/docs/index.html", "https://example.com/docs"],
    ["https://example.com/?b=2&a=1", "https://example.com/?a=1&b=2"],
    ["https://example.com/p?utm_source=x&id=7&gclid=abc", "https://example.com/p?id=7"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeCrawlUrl(input)).toBe(expected);
  });

  it("resolves relative links against a base", () => {
    expect(normalizeCrawlUrl("../pricing#plans", "https://example.com/products/a")).toBe("https://example.com/pricing");
  });

  it("honours query parameter modes", () => {
    expect(normalizeCrawlUrl("https://example.com/p?utm_source=x&id=7", undefined, { queryParams: "keep" })).toBe("https://example.com/p?id=7&utm_source=x");
    expect(normalizeCrawlUrl("https://example.com/p?id=7", undefined, { queryParams: "strip-all" })).toBe("https://example.com/p");
  });

  it("rejects non-crawlable URLs", () => {
    for (const u of ["mailto:a@b.com", "tel:123", "javascript:void(0)", "ftp://example.com", "https://user:pw@example.com/", "not a url"]) {
      expect(normalizeCrawlUrl(u)).toBeNull();
    }
  });

  it("treats equivalent URLs as duplicates", () => {
    const variants = ["https://example.com/about", "https://EXAMPLE.com/about/", "https://example.com/about#x", "https://example.com/about?utm_campaign=y"];
    expect(new Set(variants.map((v) => normalizeCrawlUrl(v))).size).toBe(1);
  });
});

describe("scope and safety rules", () => {
  it("enforces same-domain, optionally subdomains, never lookalikes", () => {
    expect(isInScope("https://www.example.com/", "https://example.com/x", false)).toBe(true);
    expect(isInScope("https://example.com/", "https://shop.example.com/", false)).toBe(false);
    expect(isInScope("https://example.com/", "https://shop.example.com/", true)).toBe(true);
    expect(isInScope("https://example.com/", "https://example.com.evil.io/", true)).toBe(false);
    expect(isInScope("https://example.com/", "https://notexample.com/", true)).toBe(false);
  });

  it("matches exclusions by substring or wildcard", () => {
    expect(compileExclusion("/tag/")("/blog/tag/news")).toBe(true);
    expect(compileExclusion("/blog/*/comments")("/blog/post-1/comments")).toBe(true);
    expect(compileExclusion("/blog/*/comments")("/blog/post-1")).toBe(false);
    expect(compileExclusion("  ")("/anything")).toBe(false);
  });

  it("never visits state-changing URLs", () => {
    for (const u of ["https://x.com/logout", "https://x.com/account/sign-out", "https://x.com/cart/delete/5", "https://x.com/logout.php", "https://x.com/unsubscribe?id=1", "https://x.com/?action=logout"]) {
      expect(isUnsafeToVisit(u), u).toBe(true);
    }
    expect(isUnsafeToVisit("https://x.com/about")).toBe(false);
    expect(isUnsafeToVisit("https://x.com/blog/how-to-remove-stains")).toBe(false);
  });

  it("detects crawl traps", () => {
    expect(looksLikeCrawlTrap("https://x.com/a/a/a/b")).toBe(true);
    expect(looksLikeCrawlTrap(`https://x.com/${Array.from({ length: 13 }, (_, i) => `s${i}`).join("/")}`)).toBe(true);
    expect(looksLikeCrawlTrap("https://x.com/page?jsessionid=abc")).toBe(true);
    expect(looksLikeCrawlTrap("https://x.com/blog/2024/05/post")).toBe(false);
  });

  it("UrlFrontier deduplicates and preserves order", () => {
    const f = new UrlFrontier<number>();
    expect(f.add("a", 1)).toBe(true);
    expect(f.add("b", 2)).toBe(true);
    expect(f.add("a", 3)).toBe(false);
    f.markSeen("c");
    expect(f.add("c", 4)).toBe(false);
    expect([f.next()?.url, f.next()?.url, f.next()]).toEqual(["a", "b", undefined]);
  });
});

describe("robots.txt", () => {
  const robots = parseRobotsTxt(
    `# comment
User-agent: Googlebot
Disallow: /

User-agent: *
Disallow: /private
Disallow: /*.pdf$
Allow: /private/public
Crawl-delay: 2
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/news-sitemap.xml`,
    "QAPilotAI",
  );
  it("applies the * group with longest-match precedence", () => {
    expect(robots.isAllowed("/about")).toBe(true);
    expect(robots.isAllowed("/private/data")).toBe(false);
    expect(robots.isAllowed("/private/public/page")).toBe(true);
    expect(robots.isAllowed("/files/report.pdf")).toBe(false);
    expect(robots.isAllowed("/files/report.pdf?x=1")).toBe(true);
  });
  it("collects sitemaps and crawl delay", () => {
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml", "https://example.com/news-sitemap.xml"]);
    expect(robots.crawlDelaySeconds).toBe(2);
  });
  it("uses a specific group when one names the crawler", () => {
    const r = parseRobotsTxt("User-agent: *\nDisallow: /\n\nUser-agent: QAPilotAI\nDisallow: /admin", "QAPilotAI/0.2");
    expect(r.isAllowed("/about")).toBe(true);
    expect(r.isAllowed("/admin")).toBe(false);
  });
});

describe("sitemap parsing", () => {
  it("reads urlsets and sitemap indexes, decoding entities and CDATA", () => {
    expect(parseSitemap(`<urlset><url><loc>https://e.com/a?x=1&amp;y=2</loc></url><url><loc><![CDATA[https://e.com/b]]></loc></url></urlset>`)).toEqual({ urls: ["https://e.com/a?x=1&y=2", "https://e.com/b"], sitemaps: [] });
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>`)).toEqual({ urls: [], sitemaps: ["https://e.com/s1.xml"] });
  });
});

const signals = (url: string, extra: Partial<PageSignals> = {}): PageSignals => ({
  url, isRoot: false, title: "", h1: "", metaDescription: "", passwordFields: 0, hasEmailField: false, hasTextarea: false, hasSearchInput: false,
  addToCartButtons: 0, priceElements: 0, articleElements: 0, hasCartTable: false, hasPaymentFields: false, hasLogoutLink: false,
  detailsElements: 0, schemaTypes: [], productCards: 0, ...extra,
});

describe("page type detection", () => {
  it.each([
    [signals("https://e.com/", { isRoot: true }), "HOMEPAGE"],
    [signals("https://e.com/about-us"), "ABOUT"],
    [signals("https://e.com/contact"), "CONTACT"],
    [signals("https://e.com/get-in-touch", { hasTextarea: true, hasEmailField: true }), "CONTACT"],
    [signals("https://e.com/services"), "SERVICES"],
    [signals("https://e.com/shop"), "PRODUCT_LISTING"],
    [signals("https://e.com/item-123", { schemaTypes: ["Product"] }), "PRODUCT_DETAIL"],
    [signals("https://e.com/collections/summer"), "COLLECTION"],
    [signals("https://e.com/blog"), "BLOG_LISTING"],
    [signals("https://e.com/blog/hello-world"), "BLOG_DETAIL"],
    [signals("https://e.com/help", { schemaTypes: ["FAQPage"] }), "FAQ"],
    [signals("https://e.com/pricing"), "PRICING"],
    [signals("https://e.com/signin", { passwordFields: 1 }), "LOGIN"],
    [signals("https://e.com/join", { passwordFields: 2 }), "SIGNUP"],
    [signals("https://e.com/dashboard"), "DASHBOARD"],
    [signals("https://e.com/search"), "SEARCH"],
    [signals("https://e.com/cart"), "CART"],
    [signals("https://e.com/checkout", { hasPaymentFields: true }), "CHECKOUT"],
    [signals("https://e.com/my-account"), "ACCOUNT"],
    [signals("https://e.com/lp/spring-offer"), "LANDING_PAGE"],
    [signals("https://e.com/xyz"), "OTHER"],
  ])("%#: %s", (s, expected) => {
    expect(detectPageType(s).type).toBe(expected);
  });

  it("explains its decision with a confidence", () => {
    const r = detectPageType(signals("https://e.com/product/widget", { schemaTypes: ["Product"], addToCartButtons: 1, priceElements: 1 }));
    expect(r.type).toBe("PRODUCT_DETAIL");
    expect(r.confidence).toBe(1);
    expect(r.reasons.length).toBeGreaterThan(1);
  });

  it("derives readable page names", () => {
    expect(derivePageName("About us | Fixture Co", "", "https://e.com/about")).toBe("About us");
    expect(derivePageName("", "Our Team", "https://e.com/team")).toBe("Our Team");
    expect(derivePageName("", "", "https://e.com/our-services/web-design")).toBe("Web Design");
    expect(derivePageName("", "", "https://e.com/")).toBe("Home");
  });
});

// ---------------------------------------------------------------- crawler with fake loader

type FakePage = { status?: number; links?: { href: string; source?: DiscoverySource }[]; redirect?: string; error?: string; contentType?: string };

function fakeSite(origin: string, pages: Record<string, FakePage>, extra: { robots?: string; sitemap?: string; offsite?: boolean } = {}) {
  const loads: string[] = [];
  const loader: PageLoader = {
    async load(url: string): Promise<PageLoadResult> {
      loads.push(url);
      const path = new URL(url).pathname + new URL(url).search;
      const p = pages[path];
      if (!p) return { navigation: { ok: false, status: 404, finalUrl: url, durationMs: 1 }, contentType: "text/html", extracted: null };
      if (p.error) return { navigation: { ok: false, status: null, finalUrl: url, durationMs: 1, error: { kind: "TIMEOUT", message: p.error } }, contentType: null, extracted: null };
      const finalUrl = p.redirect ? new URL(p.redirect, origin).href : url;
      const target = p.redirect ? pages[new URL(p.redirect, origin).pathname] : p;
      const extracted: ExtractedPage = {
        title: `${path} | Site`, metaDescription: "", h1: "", canonical: null, robotsMeta: "",
        links: (target?.links ?? []).map((l) => ({ href: new URL(l.href, origin).href, text: l.href, source: l.source ?? "content", rel: "", target: "", download: false })),
        signals: signals(finalUrl),
      };
      return { navigation: { ok: (p.status ?? 200) < 400, status: p.status ?? 200, finalUrl, durationMs: 1 }, contentType: p.contentType ?? "text/html", extracted };
    },
  };
  const http = async (url: string, options?: { allowRedirect?: (from: string, to: string) => boolean }): Promise<HttpResult> => {
    const u = new URL(url);
    const base = { chain: [], contentLength: null, durationMs: 1 };
    if (u.pathname === "/" && extra.offsite) {
      options?.allowRedirect?.(url, "https://other-domain.com/");
      return { ...base, ok: false, status: 301, finalUrl: "https://other-domain.com/", contentType: null };
    }
    if (u.pathname === "/robots.txt") return extra.robots ? { ...base, ok: true, status: 200, finalUrl: url, contentType: "text/plain", body: extra.robots } : { ...base, ok: false, status: 404, finalUrl: url, contentType: "text/html" };
    if (u.pathname === "/sitemap.xml") return extra.sitemap ? { ...base, ok: true, status: 200, finalUrl: url, contentType: "application/xml", body: extra.sitemap } : { ...base, ok: false, status: 404, finalUrl: url, contentType: "text/html" };
    return { ...base, ok: true, status: 200, finalUrl: url, contentType: "text/html" };
  };
  return { loader, http, loads };
}

async function crawl(site: ReturnType<typeof fakeSite>, origin: string, config: Parameters<WebsiteCrawler["crawl"]>[1] = {}, offsite = false) {
  const pages = new Map<string, CrawledPage>();
  const crawler = new WebsiteCrawler({ loader: site.loader, http: site.http, sleep: async () => undefined, politenessDelayMs: 0 });
  const summary = await crawler.crawl(origin, config, { onPage: (p) => void pages.set(new URL(p.normalizedUrl).pathname, p) });
  void offsite;
  return { summary, pages };
}

describe("WebsiteCrawler (fake browser)", () => {
  const origin = "https://site.test";

  it("deduplicates, respects depth, follows sitemap URLs and merges discovery sources", async () => {
    const site = fakeSite(
      origin,
      {
        "/": { links: [{ href: "/a", source: "navigation" }, { href: "/a/", source: "footer" }, { href: "/a#x", source: "cta" }, { href: "/b" }, { href: "https://elsewhere.com/x" }] },
        "/a": { links: [{ href: "/deep" }] },
        "/b": { links: [{ href: "/" }] },
        "/deep": { links: [{ href: "/deeper" }] },
        "/deeper": {},
        "/from-sitemap": {},
      },
      { sitemap: `<urlset><url><loc>${origin}/from-sitemap</loc></url></urlset>` },
    );
    const { summary, pages } = await crawl(site, origin, { maxDepth: 2 });
    expect(summary.status).toBe("COMPLETED");
    expect([...pages.keys()].sort()).toEqual(["/", "/a", "/b", "/deep", "/from-sitemap"]);
    expect(pages.get("/a")!.sources.sort()).toEqual(["cta", "footer", "navigation"]);
    expect(pages.get("/from-sitemap")!.sources).toContain("sitemap");
    expect(site.loads.filter((u) => u.endsWith("/a"))).toHaveLength(1);
  });

  it("keeps crawling after a page fails, retries transient errors, and caps page count", async () => {
    const site = fakeSite(origin, { "/": { links: [{ href: "/broken" }, { href: "/slow" }, { href: "/ok1" }, { href: "/ok2" }, { href: "/ok3" }] }, "/broken": { status: 500 }, "/slow": { error: "Timeout 30000ms exceeded" }, "/ok1": {}, "/ok2": {}, "/ok3": {} });
    const { summary, pages } = await crawl(site, origin, { maxPages: 5, retries: 2 });
    expect(summary.status).toBe("COMPLETED");
    expect(pages.get("/broken")).toMatchObject({ crawlStatus: "FAILED", httpStatus: 500 });
    expect(pages.get("/slow")).toMatchObject({ crawlStatus: "FAILED" });
    expect(site.loads.filter((u) => u.endsWith("/slow"))).toHaveLength(3);
    expect(pages.size).toBe(5);
    expect(summary.progress.skipped).toBeGreaterThan(0);
  });

  it("collapses redirects to an already known page", async () => {
    const site = fakeSite(origin, { "/": { links: [{ href: "/about" }, { href: "/old-about" }] }, "/about": {}, "/old-about": { redirect: "/about" } });
    const { pages } = await crawl(site, origin);
    expect(pages.get("/old-about")).toMatchObject({ crawlStatus: "SKIPPED" });
    expect(pages.get("/about")!.sources).toContain("redirect");
  });

  it("applies robots.txt, exclusions and unsafe-URL rules", async () => {
    const site = fakeSite(origin, { "/": { links: [{ href: "/private/x" }, { href: "/tag/news" }, { href: "/logout" }, { href: "/file.pdf" }, { href: "/ok" }] }, "/private/x": {}, "/tag/news": {}, "/logout": {}, "/ok": {} }, { robots: "User-agent: *\nDisallow: /private" });
    const { pages } = await crawl(site, origin, { exclusions: ["/tag/"] });
    expect(pages.get("/private/x")).toMatchObject({ crawlStatus: "SKIPPED", errorMessage: "Disallowed by robots.txt" });
    expect(pages.has("/tag/news")).toBe(false);
    expect(pages.has("/logout")).toBe(false);
    expect(pages.has("/file.pdf")).toBe(false);
    expect(pages.get("/ok")?.crawlStatus).toBe("CRAWLED");
    expect(site.loads.some((u) => u.includes("/logout") || u.includes("/private"))).toBe(false);
  });

  it("stops when the site redirects to another domain", async () => {
    const site = fakeSite(origin, { "/": {} }, { offsite: true });
    const { summary } = await crawl(site, origin);
    expect(summary.status).toBe("FAILED");
    expect(summary.error).toMatch(/redirects to a different domain/);
  });

  it("rejects invalid start URLs before any request", async () => {
    const site = fakeSite(origin, {});
    const { summary } = await crawl(site, "javascript:alert(1)");
    expect(summary.status).toBe("FAILED");
    expect(site.loads).toHaveLength(0);
  });
});
