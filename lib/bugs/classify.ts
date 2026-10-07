import { createHash } from "node:crypto";
import { normalizeCrawlUrl } from "@/lib/crawler/normalize";
import type { BugPriority, BugSeverity, PageType } from "@/types";

/**
 * Deterministic identity of a failure: normalised page URL + the test case's stable key
 * (module + check + element, see CaseSpec.key). The same failure on the same page always maps to
 * the same fingerprint, across browsers, viewports and runs.
 */
export function bugFingerprint(pageUrl: string, caseKey: string): string {
  const specKey = caseKey.includes("|") ? caseKey.slice(caseKey.indexOf("|") + 1) : caseKey;
  const page = normalizeCrawlUrl(pageUrl) ?? pageUrl;
  return createHash("sha256").update(`${page}\n${specKey}`).digest("hex").slice(0, 32);
}

export interface SeverityInput {
  module: string;
  caseKey: string;
  title: string;
  section: string | null;
  actual: string;
  viewport: string | null;
  pageType: PageType | null;
  /** Highest axe impact among the result's accessibility rows, when relevant. */
  axeImpact: string | null;
  /** HTTP status found in the evidence, when relevant. */
  httpStatus: number | null;
}

/** Rules are evaluated in order; the first match decides. Each carries a human-readable reason. */
export function classifySeverity(i: SeverityInput): { severity: BugSeverity; reason: string } {
  const key = i.caseKey.toLowerCase();
  const text = `${i.title} ${i.actual}`.toLowerCase();
  const mobile = (i.viewport ?? "").startsWith("mobile");
  const status = i.httpStatus;

  if (i.module === "page-load") {
    if ((status !== null && status >= 500) || /dns|ssl|certificate|could not be resolved/.test(text)) return { severity: "CRITICAL", reason: "The page cannot be loaded (server, DNS or TLS failure)." };
    return { severity: "HIGH", reason: "The page returns an error status." };
  }
  if (i.module === "ecommerce") {
    if (/add-to-cart|checkout/.test(key)) return { severity: "CRITICAL", reason: "Add-to-cart or checkout is broken, blocking purchases." };
    return { severity: "HIGH", reason: "A cart or product interaction is broken." };
  }
  if (["login", "logout"].includes(i.module)) return { severity: "HIGH", reason: "Authentication behaviour is broken." };
  if (i.module === "forms" || i.module === "newsletter") {
    if (/labels/.test(key)) return { severity: "MEDIUM", reason: "Form fields lack accessible labels." };
    return { severity: "HIGH", reason: "A form does not validate or submit as expected." };
  }
  if (i.module === "console") return { severity: "HIGH", reason: "Uncaught JavaScript errors occur while the page loads." };
  if (i.module === "network") {
    if (/scripts|stylesheets/.test(key)) return { severity: "HIGH", reason: "Site JavaScript or CSS fails to load." };
    return { severity: "MEDIUM", reason: "Site resources fail to load." };
  }
  if (i.module === "links" || i.module === "social-links" || i.module === "downloads") {
    if (/mailto|tel:/.test(key)) return { severity: "LOW", reason: "A contact link is malformed." };
    const prominent = ["Header", "Navigation", "Footer"].includes(i.section ?? "");
    if (prominent || (status !== null && status >= 500)) return { severity: "HIGH", reason: prominent ? `A ${i.section?.toLowerCase()} link is broken.` : "A link target returns a server error." };
    return { severity: "MEDIUM", reason: "A link or download is broken." };
  }
  if (i.module === "navigation") return { severity: /nav-link|menu-toggle/.test(key) ? "HIGH" : "MEDIUM", reason: "Site navigation does not work as expected." };
  if (i.module === "accessibility") {
    if (i.axeImpact === "critical") return { severity: "HIGH", reason: "Critical-impact automated accessibility violation." };
    if (i.axeImpact === "serious") return { severity: "MEDIUM", reason: "Serious-impact automated accessibility violation." };
    return { severity: "LOW", reason: "Moderate/minor automated accessibility violation." };
  }
  if (i.module === "ui" || i.module === "responsive") {
    if (/form-fit/.test(key)) return { severity: "HIGH", reason: "Form controls are outside the viewport." };
    if (/horizontal-overflow/.test(key)) return { severity: mobile ? "HIGH" : "MEDIUM", reason: `The page scrolls horizontally${mobile ? " on mobile" : ""}.` };
    return { severity: "MEDIUM", reason: "A measured layout defect affects visible content." };
  }
  if (i.module === "seo") {
    if (/(^|:)title$/.test(key) || /broken-links/.test(key)) return { severity: "MEDIUM", reason: "A required SEO element is missing or links are broken." };
    return { severity: "LOW", reason: "SEO metadata problem." };
  }
  if (i.module === "performance") return { severity: "MEDIUM", reason: "A performance measurement is in the 'poor' range." };
  if (i.module === "content") {
    if (/spelling/.test(key)) return { severity: "LOW", reason: "Spelling differs from the reference document." };
    return { severity: "MEDIUM", reason: "Page content differs from the reference document." };
  }
  if (i.module === "typography") return { severity: "LOW", reason: "Typography differs from the reference." };
  return { severity: "MEDIUM", reason: "A verified functional failure." };
}

const KEY_PAGES = new Set<PageType>(["HOMEPAGE", "CHECKOUT", "CART", "LOGIN"]);
const ORDER: BugPriority[] = ["P0", "P1", "P2", "P3"];

/** Priority follows severity, raised one level on business-critical page types. */
export function priorityFor(severity: BugSeverity, pageType: PageType | null): { priority: BugPriority; reason: string } {
  const base = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[severity];
  const bump = pageType && KEY_PAGES.has(pageType) && severity !== "LOW" && base > 0;
  return { priority: ORDER[bump ? base - 1 : base], reason: bump ? `${severity} on a ${pageType.toLowerCase()} page (raised one level)` : `${severity} severity` };
}

/** Extracts an HTTP status code mentioned in evidence text ("Status: 404", "HTTP 500"). */
export function httpStatusFrom(text: string): number | null {
  const m = /\b(?:status:?|HTTP)\s*(\d{3})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}
