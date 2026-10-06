import type { Page } from "playwright";
import type { DiscoverySource } from "@/types";
import type { PageSignals } from "./page-type";

export interface ExtractedLink {
  href: string;
  text: string;
  source: DiscoverySource;
  rel: string;
  target: string;
  download: boolean;
}

export interface ExtractedPage {
  title: string;
  metaDescription: string;
  h1: string;
  canonical: string | null;
  robotsMeta: string;
  links: ExtractedLink[];
  signals: Omit<PageSignals, "url" | "isRoot">;
}

/**
 * Runs inside the page. Plain JavaScript string on purpose: transpiler helpers must never leak
 * into browser-evaluated code. Classifies every anchor by where it sits in the layout, and finds
 * non-anchor elements that navigate (data-href / onclick location assignments).
 */
const EXTRACT_SCRIPT = String.raw`(() => {
  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const isCta = (el) => {
    const cls = (el.getAttribute("class") || "").toLowerCase();
    return el.getAttribute("role") === "button" || /(^|[\s_-])(btn|button|cta)([\s_-]|$)/.test(cls);
  };
  const sourceOf = (el) => {
    if (el.closest('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, [itemtype*="BreadcrumbList"]')) return "breadcrumb";
    const rel = (el.getAttribute("rel") || "").toLowerCase();
    if (/\b(next|prev)\b/.test(rel) || el.closest('.pagination, .pager, [aria-label*="pagination" i], nav.pages')) return "pagination";
    if (el.closest('footer, [role="contentinfo"]')) return "footer";
    if (el.closest('nav, [role="navigation"], [role="menubar"], [role="menu"]')) return "navigation";
    if (el.closest('header, [role="banner"]')) return "header";
    if (isCta(el)) return "cta";
    return "content";
  };

  const links = [];
  for (const a of document.querySelectorAll("a[href], area[href]")) {
    const raw = a.getAttribute("href") || "";
    links.push({
      href: raw.trim() === "" ? "" : a.href,
      text: (text(a) || a.getAttribute("aria-label") || a.getAttribute("title") || "").slice(0, 200),
      source: sourceOf(a),
      rel: a.getAttribute("rel") || "",
      target: a.getAttribute("target") || "",
      download: a.hasAttribute("download"),
    });
  }

  const urlFromOnclick = (code) => {
    const m = /(?:location(?:\.href)?\s*=|location\.assign\(|window\.open\()\s*['"]([^'"]+)['"]/.exec(code || "");
    return m ? m[1] : null;
  };
  for (const el of document.querySelectorAll("button, [role=button], [data-href], [data-url], [data-link], [onclick]")) {
    if (el.closest("a[href]")) continue;
    const target = el.getAttribute("data-href") || el.getAttribute("data-url") || el.getAttribute("data-link") || urlFromOnclick(el.getAttribute("onclick"));
    if (!target) continue;
    try {
      links.push({ href: new URL(target, location.href).href, text: text(el).slice(0, 200), source: "button", rel: "", target: "", download: false });
    } catch (e) {}
  }

  const schemaTypes = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        const t = n["@type"];
        if (typeof t === "string") schemaTypes.push(t);
        else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && schemaTypes.push(x));
        if (n["@graph"]) walk(n["@graph"]);
        if (n.mainEntity) walk(n.mainEntity);
      };
      walk(JSON.parse(s.textContent || "null"));
    } catch (e) {}
  }
  for (const el of document.querySelectorAll("[itemtype]")) {
    const t = (el.getAttribute("itemtype") || "").split("/").pop();
    if (t) schemaTypes.push(t);
  }

  const buttonsText = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button], [class*="add-to-cart" i]')).map((b) => (text(b) || b.getAttribute("value") || "").toLowerCase());
  const meta = (name) => (document.querySelector('meta[name="' + name + '"]') || {}).content || "";
  const canonical = document.querySelector('link[rel="canonical"]');

  return {
    title: document.title || "",
    metaDescription: meta("description") || ((document.querySelector('meta[property="og:description"]') || {}).content || ""),
    h1: text(document.querySelector("h1")).slice(0, 300),
    canonical: canonical ? canonical.href : null,
    robotsMeta: meta("robots").toLowerCase(),
    links,
    signals: {
      title: document.title || "",
      h1: text(document.querySelector("h1")).slice(0, 300),
      metaDescription: meta("description"),
      passwordFields: document.querySelectorAll('input[type="password"]').length,
      hasEmailField: !!document.querySelector('input[type="email"], input[name*="email" i]'),
      hasTextarea: !!document.querySelector("form textarea"),
      hasSearchInput: !!document.querySelector('input[type="search"], [role="search"] input, input[name="q"], input[name="s"], input[name="search"]'),
      addToCartButtons: buttonsText.filter((t) => /add to (cart|bag|basket)/.test(t)).length,
      priceElements: document.querySelectorAll('[itemprop="price"], .price, [class*="price" i]:not([class*="pricing" i])').length,
      articleElements: document.querySelectorAll("article").length,
      hasCartTable: !!document.querySelector('[class*="cart-item" i], [class*="cart_item" i], [class*="line-item" i], form[action*="cart" i] table'),
      hasPaymentFields: !!document.querySelector('input[autocomplete="cc-number"], input[name*="cardnumber" i], input[name*="card_number" i], input[name*="cvv" i], input[name*="cvc" i], iframe[src*="stripe" i], iframe[name*="card" i]'),
      hasLogoutLink: Array.from(document.querySelectorAll("a[href]")).some((a) => /log ?out|sign ?out/i.test(text(a))),
      detailsElements: document.querySelectorAll("details").length,
      schemaTypes,
      productCards: document.querySelectorAll('[class*="product-card" i], [class*="product-item" i], [itemtype*="Product"], li.product').length,
    },
  };
})()`;

export async function extractPage(page: Page): Promise<ExtractedPage> {
  return (await page.evaluate(EXTRACT_SCRIPT)) as ExtractedPage;
}
