import type { Page } from "playwright";
import { CRAWLER_TOKEN, fetchUrl } from "@/lib/net/http";
import { parseRobotsTxt } from "@/lib/crawler/robots";
import { parseSitemap } from "@/lib/crawler/sitemap";
import type { ExpectationSource } from "@/types";
import { runScript } from "../browser-scripts";
import type { PageTestContext, TestModule } from "../context";
import { detail } from "../details";
import { classifyLinkKind } from "../link-check";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { inspect, spec } from "./helpers";

export interface SeoSnapshot {
  url: string;
  title: string | null;
  metaDescription: string | null;
  headings: { level: number; text: string }[];
  canonicals: string[];
  robotsMeta: string | null;
  images: { src: string; alt: string | null }[];
  og: Record<string, string>;
  twitter: Record<string, string>;
}

const SEO_SCRIPT = String.raw`() => {
  const meta = (sel) => { const el = document.querySelector(sel); return el ? (el.getAttribute("content") || "").trim() : null; };
  const collect = (prefix, attr) => Object.fromEntries(Array.from(document.querySelectorAll('meta[' + attr + '^="' + prefix + '"]')).map((m) => [m.getAttribute(attr), (m.getAttribute("content") || "").trim()]));
  return {
    url: location.href,
    title: document.querySelector("head title") ? document.title.trim() : null,
    metaDescription: meta('meta[name="description" i]'),
    headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => ({ level: Number(h.tagName[1]), text: (h.innerText || h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) })),
    canonicals: Array.from(document.querySelectorAll('link[rel="canonical" i]')).map((l) => l.href),
    robotsMeta: meta('meta[name="robots" i]'),
    images: Array.from(document.images).slice(0, 200).map((i) => ({ src: i.currentSrc || i.getAttribute("src") || "", alt: i.getAttribute("alt") })),
    og: collect("og:", "property"),
    twitter: collect("twitter:", "name"),
  };
}`;

export function collectSeo(page: Page): Promise<SeoSnapshot> {
  return runScript<SeoSnapshot>(page, SEO_SCRIPT);
}

export interface SeoFinding {
  key: string;
  title: string;
  status: "PASS" | "FAIL" | "WARNING" | "NOT APPLICABLE";
  observed: string;
  expected: string;
  message: string;
  source: ExpectationSource;
}

/** Pure, page-level checks over the extracted metadata. */
export function analyzeSeo(s: SeoSnapshot): SeoFinding[] {
  const f: SeoFinding[] = [];
  const push = (x: SeoFinding) => f.push(x);
  const title = s.title ?? "";
  push(
    !title
      ? { key: "title", title: "Page has a title", status: "FAIL", observed: s.title === null ? "no <title> element" : "empty <title>", expected: "A non-empty <title>", message: "The page has no title", source: "BROWSER_STANDARD" }
      : title.length < 10 || title.length > 60
        ? { key: "title", title: "Page has a title", status: "WARNING", observed: `${title.length} characters: "${title}"`, expected: "10–60 characters", message: `Title length ${title.length} is outside 10–60 characters`, source: "DETECTED_FUNCTIONALITY" }
        : { key: "title", title: "Page has a title", status: "PASS", observed: `"${title}" (${title.length} characters)`, expected: "10–60 characters", message: "Title present with a typical length", source: "BROWSER_STANDARD" },
  );
  const d = s.metaDescription ?? "";
  push(
    !d
      ? { key: "meta-description", title: "Page has a meta description", status: "WARNING", observed: "missing", expected: "50–160 characters", message: "No meta description", source: "DETECTED_FUNCTIONALITY" }
      : d.length < 50 || d.length > 160
        ? { key: "meta-description", title: "Page has a meta description", status: "WARNING", observed: `${d.length} characters`, expected: "50–160 characters", message: `Meta description length ${d.length} is outside 50–160 characters`, source: "DETECTED_FUNCTIONALITY" }
        : { key: "meta-description", title: "Page has a meta description", status: "PASS", observed: `${d.length} characters`, expected: "50–160 characters", message: "Meta description present", source: "DETECTED_FUNCTIONALITY" },
  );
  const h1s = s.headings.filter((h) => h.level === 1);
  push(
    h1s.length === 1
      ? { key: "h1", title: "Page has exactly one H1", status: "PASS", observed: `"${h1s[0].text}"`, expected: "One H1", message: "One H1", source: "DETECTED_FUNCTIONALITY" }
      : { key: "h1", title: "Page has exactly one H1", status: "WARNING", observed: `${h1s.length} H1 elements${h1s.length ? `: ${h1s.map((h) => `"${h.text}"`).join(", ")}` : ""}`, expected: "One H1", message: h1s.length ? "Multiple H1 headings" : "No H1 heading", source: "DETECTED_FUNCTIONALITY" },
  );
  const skips: string[] = [];
  for (let i = 1; i < s.headings.length; i++) {
    if (s.headings[i].level > s.headings[i - 1].level + 1) skips.push(`H${s.headings[i - 1].level} → H${s.headings[i].level} ("${s.headings[i].text}")`);
  }
  push(
    s.headings.length === 0
      ? { key: "heading-hierarchy", title: "Heading levels are not skipped", status: "NOT APPLICABLE", observed: "no headings", expected: "No skipped levels", message: "The page has no headings", source: "DETECTED_FUNCTIONALITY" }
      : skips.length
        ? { key: "heading-hierarchy", title: "Heading levels are not skipped", status: "WARNING", observed: skips.join("; "), expected: "Each heading at most one level deeper than the previous", message: `${skips.length} skipped heading level(s)`, source: "DETECTED_FUNCTIONALITY" }
        : { key: "heading-hierarchy", title: "Heading levels are not skipped", status: "PASS", observed: s.headings.map((h) => `H${h.level}`).join(" "), expected: "No skipped levels", message: "Heading outline is sequential", source: "DETECTED_FUNCTIONALITY" },
  );
  if (s.canonicals.length === 0) push({ key: "canonical", title: "Canonical URL is declared", status: "WARNING", observed: "missing", expected: "One absolute canonical URL", message: "No canonical link", source: "DETECTED_FUNCTIONALITY" });
  else if (s.canonicals.length > 1) push({ key: "canonical", title: "Canonical URL is declared", status: "WARNING", observed: s.canonicals.join(", "), expected: "Exactly one canonical link", message: "Conflicting canonical links", source: "DETECTED_FUNCTIONALITY" });
  else {
    const c = s.canonicals[0];
    const same = (() => {
      try {
        return new URL(c).hostname.replace(/^www\./, "") === new URL(s.url).hostname.replace(/^www\./, "");
      } catch {
        return false;
      }
    })();
    push(same ? { key: "canonical", title: "Canonical URL is declared", status: "PASS", observed: c, expected: "One canonical URL on this site", message: "Canonical present", source: "DETECTED_FUNCTIONALITY" } : { key: "canonical", title: "Canonical URL is declared", status: "WARNING", observed: c, expected: "Canonical on the same site", message: "Canonical points to another domain", source: "DETECTED_FUNCTIONALITY" });
  }
  const robots = (s.robotsMeta ?? "").toLowerCase();
  push(
    /noindex|nofollow|none/.test(robots)
      ? { key: "robots-meta", title: "Page is indexable", status: "WARNING", observed: `meta robots="${s.robotsMeta}"`, expected: "No noindex/nofollow unless intended", message: "Page asks search engines not to index or follow it; confirm this is intentional", source: "DETECTED_FUNCTIONALITY" }
      : { key: "robots-meta", title: "Page is indexable", status: "PASS", observed: s.robotsMeta ? `meta robots="${s.robotsMeta}"` : "no robots meta (indexable by default)", expected: "Indexable", message: "Indexable", source: "BROWSER_STANDARD" },
  );
  const noAlt = s.images.filter((i) => i.alt === null && i.src);
  push(
    s.images.length === 0
      ? { key: "image-alt", title: "Images have alt attributes", status: "NOT APPLICABLE", observed: "no images", expected: "alt on every image", message: "No images", source: "BROWSER_STANDARD" }
      : noAlt.length
        ? { key: "image-alt", title: "Images have alt attributes", status: "WARNING", observed: `${noAlt.length} of ${s.images.length} without alt: ${noAlt.slice(0, 5).map((i) => i.src).join(", ")}`, expected: 'alt on every image (alt="" for decorative images)', message: `${noAlt.length} image(s) missing alt`, source: "BROWSER_STANDARD" }
        : { key: "image-alt", title: "Images have alt attributes", status: "PASS", observed: `${s.images.length} images, all with alt`, expected: "alt on every image", message: "All images have alt", source: "BROWSER_STANDARD" },
  );
  const ogMissing = ["og:title", "og:description", "og:image", "og:url"].filter((k) => !s.og[k]);
  push(
    ogMissing.length
      ? { key: "open-graph", title: "Open Graph metadata is present", status: "WARNING", observed: Object.keys(s.og).length ? `present: ${Object.keys(s.og).join(", ")}` : "none", expected: "og:title, og:description, og:image, og:url", message: `Missing ${ogMissing.join(", ")}`, source: "DETECTED_FUNCTIONALITY" }
      : { key: "open-graph", title: "Open Graph metadata is present", status: "PASS", observed: Object.keys(s.og).join(", "), expected: "og:title, og:description, og:image, og:url", message: "Open Graph complete", source: "DETECTED_FUNCTIONALITY" },
  );
  push(
    s.twitter["twitter:card"]
      ? { key: "twitter", title: "Twitter card metadata is present", status: "PASS", observed: Object.entries(s.twitter).map(([k, v]) => `${k}=${v}`).join(", "), expected: "twitter:card", message: "Twitter card present", source: "DETECTED_FUNCTIONALITY" }
      : { key: "twitter", title: "Twitter card metadata is present", status: "WARNING", observed: Object.keys(s.twitter).length ? Object.keys(s.twitter).join(", ") : "none", expected: "twitter:card (falls back to Open Graph if absent)", message: "No twitter:card", source: "DETECTED_FUNCTIONALITY" },
  );
  return f;
}

/** Duplicate titles / descriptions across tested pages. */
export function findDuplicates(pages: { pageId: string; url: string; title: string | null; description: string | null }[]) {
  const dup = (field: "title" | "description") => {
    const groups = new Map<string, typeof pages>();
    for (const p of pages) {
      const v = (p[field] ?? "").trim().toLowerCase();
      if (v) groups.set(v, [...(groups.get(v) ?? []), p]);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  };
  return { titles: dup("title"), descriptions: dup("description") };
}

interface SiteChecks {
  robots: SeoFinding;
  sitemap: SeoFinding;
}

async function siteChecks(ctx: PageTestContext): Promise<SiteChecks> {
  const key = "seo:site";
  const cached = ctx.shared.get(key) as Promise<SiteChecks> | undefined;
  if (cached) return cached;
  const work = (async (): Promise<SiteChecks> => {
    const origin = new URL(ctx.url).origin;
    const res = await fetchUrl(`${origin}/robots.txt`, { readBody: true, timeoutMs: 10_000, maxBodyBytes: 512 * 1024 });
    const hasRobots = res.ok && !!res.body && !/text\/html/i.test(res.contentType ?? "");
    const rules = hasRobots ? parseRobotsTxt(res.body!, CRAWLER_TOKEN) : null;
    const robots: SeoFinding = hasRobots
      ? { key: "robots-txt", title: "robots.txt is available", status: "PASS", observed: `${origin}/robots.txt (HTTP ${res.status}), ${rules!.sitemaps.length} sitemap reference(s)`, expected: "robots.txt served", message: "robots.txt found", source: "DETECTED_FUNCTIONALITY" }
      : { key: "robots-txt", title: "robots.txt is available", status: "WARNING", observed: `${origin}/robots.txt → ${res.status ?? res.error?.kind}`, expected: "robots.txt served with HTTP 200", message: "No robots.txt", source: "DETECTED_FUNCTIONALITY" };
    const candidates = [...(rules?.sitemaps ?? []), `${origin}/sitemap.xml`];
    let sitemap: SeoFinding = { key: "sitemap", title: "XML sitemap is available", status: "WARNING", observed: `checked ${candidates.join(", ")}`, expected: "A sitemap declared in robots.txt or at /sitemap.xml", message: "No sitemap found", source: "DETECTED_FUNCTIONALITY" };
    for (const url of candidates.slice(0, 3)) {
      const sm = await fetchUrl(url, { readBody: true, timeoutMs: 15_000, maxBodyBytes: 10 * 1024 * 1024 });
      if (sm.ok && sm.body && /<(urlset|sitemapindex)\b/i.test(sm.body)) {
        const parsed = parseSitemap(sm.body);
        sitemap = { key: "sitemap", title: "XML sitemap is available", status: "PASS", observed: `${url}: ${parsed.urls.length} URLs, ${parsed.sitemaps.length} nested sitemaps`, expected: "Valid XML sitemap", message: "Sitemap found", source: "DETECTED_FUNCTIONALITY" };
        break;
      }
    }
    return { robots, sitemap };
  })();
  ctx.shared.set(key, work);
  return work;
}

const toOutcome = (f: SeoFinding, extraEvidence: string | null = null): CheckOutcome => {
  const s = spec("seo", f.key, { title: f.title, section: "SEO", feature: "SEO", element: f.key, steps: ["Read the rendered page's metadata", `Evaluate ${f.key}`], expected: f.expected, expectationSource: f.source });
  const row = detail("seo_results", { check_key: f.key, status: f.status, observed_value: f.observed.slice(0, 2000), message: f.message, expected: f.expected });
  const ev = [evidence.dom(`SEO: ${f.key}`, `Observed: ${f.observed}${extraEvidence ? `\n${extraEvidence}` : ""}`)];
  switch (f.status) {
    case "PASS":
      return outcome.pass(s, f.message, [`Observed: ${f.observed}`], { details: [row] });
    case "FAIL":
      return outcome.fail(s, `${f.message}. Observed: ${f.observed}`, ev, { details: [row] });
    case "WARNING":
      return outcome.warn(s, `${f.message}. Observed: ${f.observed}`, { evidence: ev, details: [row] });
    default:
      return { ...outcome.notApplicable(s, f.message), details: [row] };
  }
};

const SHARED_PAGES = "seo:pages";

export const seoModule: TestModule = {
  id: "seo",
  scope: "page",
  async run(ctx) {
    const snap = await collectSeo(ctx.session.page);
    const findings = analyzeSeo(snap);
    const pages = (ctx.shared.get(SHARED_PAGES) as { pageId: string; url: string; title: string | null; description: string | null }[] | undefined) ?? [];
    pages.push({ pageId: ctx.pageId, url: ctx.url, title: snap.title, description: snap.metaDescription });
    ctx.shared.set(SHARED_PAGES, pages);

    // Linked resources that must resolve: canonical URL and Open Graph image.
    for (const [key, url] of [["canonical", snap.canonicals.length === 1 ? snap.canonicals[0] : null], ["open-graph", snap.og["og:image"] ? new URL(snap.og["og:image"], ctx.url).href : null]] as const) {
      if (!url) continue;
      const check = await ctx.linkChecker.check(url);
      if (check.verdict.status === "FAIL") {
        const i = findings.findIndex((f) => f.key === key);
        findings[i] = { ...findings[i], status: "FAIL", message: `${key === "canonical" ? "Canonical URL" : "og:image"} does not resolve: ${check.verdict.actual}`, observed: url };
      }
    }

    const site = await siteChecks(ctx);
    const results = findings.map((f) => toOutcome(f));
    if (pages.length === 1) results.push(toOutcome(site.robots), toOutcome(site.sitemap));
    else {
      // robots.txt applies per page: report if this page is blocked from crawling.
      const origin = new URL(ctx.url).origin;
      const r = await fetchUrl(`${origin}/robots.txt`, { readBody: true, timeoutMs: 10_000 });
      if (r.ok && r.body) {
        const u = new URL(ctx.url);
        if (!parseRobotsTxt(r.body, "Googlebot").isAllowed(`${u.pathname}${u.search}`)) {
          results.push(toOutcome({ key: "robots-txt", title: "Page is crawlable per robots.txt", status: "WARNING", observed: `Disallowed for Googlebot: ${u.pathname}`, expected: "Allowed unless intended", message: "robots.txt blocks this page", source: "DETECTED_FUNCTIONALITY" }));
        }
      }
    }

    // Broken links (internal and external), reusing the run's link cache.
    const insp = await inspect(ctx);
    const targets = [...new Set(insp.links.map((l) => l.href).filter((h, i) => ["internal", "external"].includes(classifyLinkKind(insp.links[i].rawHref, h, ctx.url, false))))].slice(0, ctx.options.maxLinksPerPage);
    const checks = await Promise.all(targets.map((t) => ctx.linkChecker.check(t)));
    const broken = checks.filter((c) => c.verdict.status === "FAIL");
    results.push(
      toOutcome(
        broken.length
          ? { key: "broken-links", title: "Page has no broken links", status: "FAIL", observed: broken.map((b) => `${b.url} → ${b.verdict.actual}`).join("; ").slice(0, 1500), expected: "All links resolve", message: `${broken.length} broken link(s)`, source: "BROWSER_STANDARD" }
          : { key: "broken-links", title: "Page has no broken links", status: targets.length ? "PASS" : "NOT APPLICABLE", observed: `${targets.length} link(s) checked`, expected: "All links resolve", message: targets.length ? "No broken links" : "No links", source: "BROWSER_STANDARD" },
      ),
    );
    return results;
  },
  async afterRun(shared) {
    const pages = (shared.get(SHARED_PAGES) as { pageId: string; url: string; title: string | null; description: string | null }[] | undefined) ?? [];
    if (pages.length < 2) return [];
    const { titles, descriptions } = findDuplicates(pages);
    const out: { page: { id: string; url: string }; outcome: CheckOutcome }[] = [];
    for (const p of pages) {
      const t = titles.find((g) => g.some((x) => x.pageId === p.pageId));
      const d = descriptions.find((g) => g.some((x) => x.pageId === p.pageId));
      const others = (g: typeof pages) => g.filter((x) => x.pageId !== p.pageId).map((x) => x.url).join(", ");
      out.push({
        page: { id: p.pageId, url: p.url },
        outcome: toOutcome(
          t
            ? { key: "duplicate-title", title: "Title is unique across tested pages", status: "WARNING", observed: `"${p.title}" also used by ${others(t)}`, expected: "Unique titles", message: "Duplicate title", source: "DETECTED_FUNCTIONALITY" }
            : { key: "duplicate-title", title: "Title is unique across tested pages", status: p.title ? "PASS" : "NOT APPLICABLE", observed: p.title ? `unique among ${pages.length} pages` : "no title", expected: "Unique titles", message: p.title ? "Unique" : "No title", source: "DETECTED_FUNCTIONALITY" },
        ),
      });
      out.push({
        page: { id: p.pageId, url: p.url },
        outcome: toOutcome(
          d
            ? { key: "duplicate-description", title: "Meta description is unique across tested pages", status: "WARNING", observed: `Same description as ${others(d)}`, expected: "Unique descriptions", message: "Duplicate meta description", source: "DETECTED_FUNCTIONALITY" }
            : { key: "duplicate-description", title: "Meta description is unique across tested pages", status: p.description ? "PASS" : "NOT APPLICABLE", observed: p.description ? `unique among ${pages.length} pages` : "no description", expected: "Unique descriptions", message: p.description ? "Unique" : "No description", source: "DETECTED_FUNCTIONALITY" },
        ),
      });
    }
    return out;
  },
};
