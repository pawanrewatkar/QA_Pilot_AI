import type { Page } from "playwright";
import { runScript } from "@/lib/testing/browser-scripts";
import type { ContentExclusion } from "@/types";
import type { PageContent } from "./types";

/** CSS selectors for each content-exclusion preset. */
export const EXCLUSION_SELECTORS: Record<ContentExclusion, string[]> = {
  header: ["header", '[role="banner"]'],
  footer: ["footer", '[role="contentinfo"]'],
  navigation: ["nav", '[role="navigation"]', '[role="menubar"]'],
  cookie: ['[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]', '[class*="gdpr" i]'],
  author: ['[rel="author"]', '[itemprop="author"]', '[class*="author" i]', ".byline"],
  reviews: ['[class*="review" i]', '[id*="review" i]', '[itemprop="review"]', '[class*="testimonial" i]'],
  ads: ['[class*="advert" i]', '[id*="google_ads" i]', "ins.adsbygoogle", ".ad", ".ads", '[class*="sponsor" i]', '[aria-label*="advertisement" i]'],
  recommendations: ['[class*="related" i]', '[class*="recommend" i]', '[class*="you-may-also" i]', '[class*="upsell" i]'],
  dynamic: ["time", "[aria-live]", '[class*="countdown" i]', '[class*="timestamp" i]', '[class*="ticker" i]'],
};

export function exclusionSelectors(presets: ContentExclusion[], custom: string[]): string[] {
  return [...presets.flatMap((p) => EXCLUSION_SELECTORS[p] ?? []), ...custom.map((s) => s.trim()).filter(Boolean)];
}

/**
 * Extracts visible headings, paragraphs, list items and CTA labels in reading order,
 * skipping anything inside an excluded region. Invalid custom selectors are ignored.
 */
const PAGE_CONTENT_SCRIPT = String.raw`(selectors) => {
  const excluded = [];
  for (const sel of selectors) {
    try { document.querySelectorAll(sel).forEach((el) => excluded.push(el)); } catch (e) {}
  }
  const isExcluded = (el) => excluded.some((x) => x === el || x.contains(el));
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const blocks = [];
  const root = document.querySelector("main, [role=main]") || document.body;
  for (const el of root.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, blockquote, dd, figcaption")) {
    if (isExcluded(el) || !visible(el)) continue;
    // Skip containers whose text is already captured by a nested block (e.g. <li><p>…</p></li>).
    if ((el.tagName === "LI" || el.tagName === "BLOCKQUOTE" || el.tagName === "DD") && el.querySelector("p, h1, h2, h3, h4, h5, h6")) continue;
    const t = text(el);
    if (!t) continue;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) blocks.push({ kind: "heading", level: Number(tag[1]), text: t });
    else blocks.push({ kind: tag === "li" ? "list-item" : "paragraph", level: null, text: t });
  }
  const ctas = [];
  for (const el of root.querySelectorAll('button, [role="button"], a[class*="btn" i], a[class*="button" i], a[class*="cta" i], input[type="submit"]')) {
    if (isExcluded(el) || !visible(el)) continue;
    const t = text(el) || el.getAttribute("value") || el.getAttribute("aria-label") || "";
    if (t && t.length <= 60) ctas.push(t);
  }
  return { blocks, ctas };
}`;

export function extractPageContent(page: Page, selectors: string[]): Promise<PageContent> {
  return runScript<PageContent>(page, PAGE_CONTENT_SCRIPT, selectors);
}
