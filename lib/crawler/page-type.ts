import type { PageType } from "@/types";

/** Observable facts about a rendered page, gathered in the browser by the extractor. */
export interface PageSignals {
  url: string;
  isRoot: boolean;
  title: string;
  h1: string;
  metaDescription: string;
  passwordFields: number;
  hasEmailField: boolean;
  hasTextarea: boolean;
  hasSearchInput: boolean;
  addToCartButtons: number;
  priceElements: number;
  articleElements: number;
  hasCartTable: boolean;
  hasPaymentFields: boolean;
  hasLogoutLink: boolean;
  detailsElements: number;
  /** JSON-LD / microdata `@type` values found on the page. */
  schemaTypes: string[];
  productCards: number;
}

export interface PageTypeResult {
  type: PageType;
  confidence: number;
  reasons: string[];
}

type Scores = Map<PageType, { score: number; reasons: string[] }>;

const PATH_RULES: [PageType, RegExp][] = [
  ["CHECKOUT", /(^|\/)(checkout|payment|place-order|onepage)(\/|$)/],
  ["CART", /(^|\/)(cart|basket|bag|shopping-cart)(\/|$)/],
  ["LOGIN", /(^|\/)(login|log-in|signin|sign-in|auth\/login|account\/login)(\/|$)/],
  ["SIGNUP", /(^|\/)(signup|sign-up|register|registration|join|create-account|account\/register)(\/|$)/],
  ["DASHBOARD", /(^|\/)(dashboard|admin|portal|app\/home)(\/|$)/],
  ["ACCOUNT", /(^|\/)(account|my-account|profile|settings|orders)(\/|$)/],
  ["SEARCH", /(^|\/)(search|results)(\/|$)/],
  ["PRICING", /(^|\/)(pricing|plans|prices|price-list)(\/|$)/],
  ["FAQ", /(^|\/)(faq|faqs|help|support\/faq|frequently-asked-questions)(\/|$)/],
  ["CONTACT", /(^|\/)(contact|contact-us|get-in-touch|enquiry|inquiry|locations?)(\/|$)/],
  ["ABOUT", /(^|\/)(about|about-us|company|our-story|team|who-we-are)(\/|$)/],
  ["SERVICES", /(^|\/)(services?|solutions?|what-we-do|capabilities)(\/|$)/],
  ["COLLECTION", /(^|\/)(collections?|categor(y|ies)|department|range)(\/|$)/],
  ["PRODUCT_LISTING", /(^|\/)(shop|store|products|catalog|catalogue)\/?$/],
  ["PRODUCT_DETAIL", /(^|\/)(product|products|item|p)\/[^/]+$/],
  ["BLOG_LISTING", /(^|\/)(blog|news|articles|insights|stories|journal)\/?(page\/\d+)?$/],
  ["BLOG_DETAIL", /(^|\/)(blog|news|articles|insights|stories|journal|posts?)\/.+/],
  ["LANDING_PAGE", /(^|\/)(lp|landing|campaigns?|promo|offers?)(\/|$)/],
];

const TITLE_RULES: [PageType, RegExp][] = [
  ["CHECKOUT", /\bcheckout\b/],
  ["CART", /\b(shopping cart|your cart|basket)\b/],
  ["LOGIN", /\b(log ?in|sign ?in)\b/],
  ["SIGNUP", /\b(sign ?up|register|create (an )?account)\b/],
  ["PRICING", /\b(pricing|plans)\b/],
  ["FAQ", /\b(faq|frequently asked)\b/],
  ["CONTACT", /\bcontact\b/],
  ["ABOUT", /\babout( us)?\b/],
  ["SERVICES", /\bservices\b/],
  ["SEARCH", /\bsearch results?\b/],
  ["BLOG_LISTING", /\b(blog|news)\b/],
  ["DASHBOARD", /\bdashboard\b/],
];

function add(scores: Scores, type: PageType, score: number, reason: string) {
  const entry = scores.get(type) ?? { score: 0, reasons: [] };
  entry.score += score;
  entry.reasons.push(reason);
  scores.set(type, entry);
}

/** Scores each candidate type from URL path, title and DOM signals; the best score wins. */
export function detectPageType(s: PageSignals): PageTypeResult {
  let path = "/";
  try {
    path = new URL(s.url).pathname.toLowerCase();
  } catch {
    /* keep root */
  }
  if (s.isRoot || path === "/") return { type: "HOMEPAGE", confidence: 1, reasons: ["Site root URL"] };

  const scores: Scores = new Map();
  const title = `${s.title} ${s.h1}`.toLowerCase();
  const schema = new Set(s.schemaTypes.map((t) => t.toLowerCase()));

  for (const [type, re] of PATH_RULES) if (re.test(path)) add(scores, type, 3, `URL path matches ${type.toLowerCase().replace(/_/g, " ")}`);
  for (const [type, re] of TITLE_RULES) if (re.test(title)) add(scores, type, 1.5, "Title/heading keyword");

  if (schema.has("product")) add(scores, "PRODUCT_DETAIL", 4, "Product structured data");
  if (schema.has("itemlist") || schema.has("offercatalog") || schema.has("collectionpage")) add(scores, "PRODUCT_LISTING", 2, "List structured data");
  if (schema.has("faqpage")) add(scores, "FAQ", 4, "FAQPage structured data");
  if (schema.has("blogposting") || schema.has("article") || schema.has("newsarticle")) add(scores, "BLOG_DETAIL", 3, "Article structured data");
  if (schema.has("blog")) add(scores, "BLOG_LISTING", 3, "Blog structured data");
  if (schema.has("contactpage")) add(scores, "CONTACT", 4, "ContactPage structured data");
  if (schema.has("aboutpage")) add(scores, "ABOUT", 4, "AboutPage structured data");
  if (schema.has("searchresultspage")) add(scores, "SEARCH", 4, "SearchResultsPage structured data");
  if (schema.has("checkoutpage")) add(scores, "CHECKOUT", 4, "CheckoutPage structured data");

  if (s.hasPaymentFields) add(scores, "CHECKOUT", 4, "Payment fields present");
  if (s.hasCartTable) add(scores, "CART", 3, "Cart line items present");
  if (s.passwordFields >= 2) add(scores, "SIGNUP", 3, "Password + confirmation fields");
  else if (s.passwordFields === 1) add(scores, "LOGIN", 2.5, "Single password field");
  if (s.addToCartButtons === 1 && s.priceElements >= 1) add(scores, "PRODUCT_DETAIL", 3, "Single add-to-cart with price");
  if (s.productCards >= 3 || s.addToCartButtons >= 3) add(scores, "PRODUCT_LISTING", 3, "Multiple product cards");
  if (s.articleElements >= 3) add(scores, "BLOG_LISTING", 2, "Multiple article previews");
  else if (s.articleElements === 1) add(scores, "BLOG_DETAIL", 1, "Single article element");
  if (s.hasTextarea && s.hasEmailField && s.passwordFields === 0) add(scores, "CONTACT", 2, "Message form with email field");
  if (s.detailsElements >= 4) add(scores, "FAQ", 1.5, "Several expandable question blocks");
  if (s.priceElements >= 3 && s.addToCartButtons === 0) add(scores, "PRICING", 1.5, "Several price points without cart");
  if (s.hasLogoutLink && s.passwordFields === 0) add(scores, "ACCOUNT", 1, "Signed-in navigation");

  let best: { type: PageType; score: number; reasons: string[] } | null = null;
  for (const [type, { score, reasons }] of scores) {
    if (!best || score > best.score) best = { type, score, reasons };
  }
  if (!best || best.score < 2) {
    return { type: "OTHER", confidence: best ? 0.2 : 0, reasons: best ? [...best.reasons, "Signals too weak to classify"] : ["No classification signals"] };
  }
  return { type: best.type, confidence: Math.min(1, Math.round((best.score / 6) * 100) / 100), reasons: best.reasons };
}

/** Human-readable page name: title without the trailing site name, else H1, else last path segment. */
export function derivePageName(title: string, h1: string, url: string): string {
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  if (cleanTitle) {
    const parts = cleanTitle.split(/\s+[|–—·•:-]\s+/);
    const first = parts[0]?.trim();
    if (first && first.length >= 2) return first.slice(0, 120);
  }
  const cleanH1 = h1.replace(/\s+/g, " ").trim();
  if (cleanH1) return cleanH1.slice(0, 120);
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!segment) return "Home";
    return decodeURIComponent(segment).replace(/[-_]+/g, " ").replace(/\.\w+$/, "").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}
