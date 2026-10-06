import type { Page } from "playwright";
import type { ExpectationSource } from "@/types";
import { runScript } from "./browser-scripts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutMeasurement {
  viewport: { width: number; height: number };
  doc: { scrollWidth: number; clientWidth: number };
  overflow: { selector: string; text: string; rect: Rect }[];
  images: { selector: string; src: string; hasSrc: boolean; complete: boolean; lazy: boolean; naturalWidth: number; naturalHeight: number; rect: Rect; objectFit: string; alt: string | null }[];
  clipped: { selector: string; text: string; control: boolean; scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; overflowX: string; overflowY: string }[];
  covered: { selector: string; text: string; rect: Rect; coveredBy: string; coveredByText: string }[];
  outsideContainer: { selector: string; container: string; text: string; overflowPx: number }[];
  groups: { container: string; items: { selector: string; text: string; rect: Rect }[] }[];
  header: { selector: string; rect: Rect; fixed: boolean } | null;
  footer: { selector: string; rect: Rect; overlapsContent: number } | null;
  navLinkRows: number;
  visibleNavLinks: number;
  menuToggleVisible: boolean;
  offscreen: { selector: string; text: string; rect: Rect }[];
  smallTargets: { selector: string; text: string; rect: Rect }[];
  formOverflow: { selector: string; rect: Rect }[];
}

/**
 * Collects layout facts in the page. It never decides what is a defect; analyzeLayout() does.
 * Plain JavaScript string: see browser-scripts.ts for why.
 */
const LAYOUT_SCRIPT = String.raw`() => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + "#" + CSS.escape(node.id)); break; }
      const cls = (typeof node.className === "string" ? node.className : "").trim().split(/\s+/).filter((c) => c && !/^(is-|has-|js-)/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const style = (el) => getComputedStyle(el);
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = style(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
  const text = (el) => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const srOnly = (el) => { const r = el.getBoundingClientRect(); return r.width <= 2 || r.height <= 2 || /sr-only|visually-hidden|screen-reader/.test(typeof el.className === "string" ? el.className : ""); };
  const hiddenByAncestor = (el) => !!el.closest('[aria-hidden="true"], [hidden], dialog:not([open])');
  const fixedAncestor = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) { const p = style(n).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  const all = Array.from(document.body.querySelectorAll("*")).filter((el) => !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "path"].includes(el.tagName));

  // Horizontal overflow: outermost elements extending past the viewport edges.
  const overflow = [];
  for (const el of all) {
    if (overflow.length >= 30 || !shown(el) || srOnly(el) || hiddenByAncestor(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right <= vw + 1 && r.left >= -1) continue;
    const p = el.parentElement;
    const pr = p ? p.getBoundingClientRect() : null;
    if (pr && (pr.right > vw + 1 || pr.left < -1) && p !== document.body) continue;
    overflow.push({ selector: cssPath(el), text: text(el), rect: rect(el) });
  }

  const images = Array.from(document.images).map((img) => ({
    selector: cssPath(img), src: img.currentSrc || img.getAttribute("src") || "", hasSrc: !!(img.getAttribute("src") || img.getAttribute("srcset")),
    complete: img.complete, lazy: img.loading === "lazy", naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, rect: rect(img),
    objectFit: style(img).objectFit, alt: img.getAttribute("alt"),
  })).filter((i) => i.rect.w > 0 || !i.hasSrc || (i.complete && i.naturalWidth === 0));

  const clipped = [];
  for (const el of document.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,a,button,li,label,span,td,th,[role=button],input[type=submit],input[type=button]")) {
    if (clipped.length >= 30 || !shown(el) || srOnly(el) || hiddenByAncestor(el)) continue;
    const s = style(el);
    const clips = (v) => v === "hidden" || v === "clip";
    if (!clips(s.overflowX) && !clips(s.overflowY)) continue;
    if (s.textOverflow === "ellipsis" || (s.webkitLineClamp && s.webkitLineClamp !== "none")) continue;
    const t = text(el);
    if (!t) continue;
    const horiz = clips(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const vert = clips(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
    if (!horiz && !vert) continue;
    const control = el.matches("a,button,[role=button],input") || /btn|button|cta/i.test(typeof el.className === "string" ? el.className : "");
    clipped.push({ selector: cssPath(el), text: t, control, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowX: s.overflowX, overflowY: s.overflowY });
  }

  // Interactive elements whose centre is covered by another, non-overlay element.
  const covered = [];
  for (const el of document.body.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[role=button]")) {
    if (covered.length >= 20 || !shown(el) || srOnly(el) || hiddenByAncestor(el)) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    if (fixedAncestor(hit) || fixedAncestor(el)) continue;
    const label = el.closest("label");
    if (label && label.contains(hit)) continue;
    covered.push({ selector: cssPath(el), text: text(el), rect: rect(el), coveredBy: cssPath(hit), coveredByText: text(hit) });
  }

  // Card-like containers with visible overflow whose children escape their box.
  const outsideContainer = [];
  for (const card of document.body.querySelectorAll('[class*="card" i], [class*="tile" i], [class*="product-item" i]')) {
    if (outsideContainer.length >= 20 || !shown(card)) continue;
    const s = style(card);
    if (s.overflow !== "visible" && s.overflowX !== "visible") continue;
    const cr = card.getBoundingClientRect();
    for (const child of card.querySelectorAll("*")) {
      if (!shown(child) || srOnly(child) || style(child).position === "absolute") continue;
      const r = child.getBoundingClientRect();
      const over = Math.max(r.right - cr.right, cr.left - r.left, r.bottom - cr.bottom, 0);
      if (over > 4 && (child.innerText || "").trim()) {
        outsideContainer.push({ selector: cssPath(child), container: cssPath(card), text: text(child), overflowPx: Math.round(over) });
        break;
      }
    }
  }

  // Repeated sibling items (cards, tiles, products) used for grid, alignment and spacing checks.
  const groups = [];
  const seenParents = new Set();
  for (const parent of document.body.querySelectorAll("*")) {
    if (groups.length >= 15 || seenParents.has(parent) || !shown(parent)) continue;
    const d = style(parent).display;
    if (!/grid|flex/.test(d)) continue;
    const kids = Array.from(parent.children).filter((c) => shown(c) && !srOnly(c));
    if (kids.length < 3) continue;
    const sig = (c) => c.tagName + "." + (typeof c.className === "string" ? c.className.trim().split(/\s+/).sort().join(".") : "");
    const first = sig(kids[0]);
    if (!kids.every((k) => sig(k) === first)) continue;
    if (!/card|tile|item|product|post|feature|col/i.test(first)) continue;
    seenParents.add(parent);
    groups.push({ container: cssPath(parent), items: kids.slice(0, 24).map((k) => ({ selector: cssPath(k), text: text(k), rect: rect(k) })) });
  }

  const headerEl = document.querySelector('header, [role="banner"]');
  const footerEl = Array.from(document.querySelectorAll('footer, [role="contentinfo"]')).pop();
  const mainEl = document.querySelector('main, [role="main"]');
  let footer = null;
  if (footerEl && shown(footerEl)) {
    const fr = footerEl.getBoundingClientRect();
    const mr = mainEl ? mainEl.getBoundingClientRect() : null;
    const fixed = style(footerEl).position === "fixed";
    footer = { selector: cssPath(footerEl), rect: rect(footerEl), overlapsContent: mr && !fixed ? Math.max(0, Math.round(mr.bottom - fr.top)) : 0 };
  }

  const navLinks = Array.from(document.querySelectorAll('header a[href], nav a[href], [role="navigation"] a[href]')).filter((a) => shown(a) && !srOnly(a));
  const navTops = new Set(navLinks.filter((a) => !a.closest("footer")).map((a) => Math.round(a.getBoundingClientRect().top / 8)));
  const toggle = Array.from(document.querySelectorAll('button[aria-controls], button[aria-expanded], .navbar-toggler, .menu-toggle, .hamburger, [aria-label*="menu" i]')).some((b) => shown(b));

  const offscreen = [];
  for (const el of document.body.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,a,button,img")) {
    if (offscreen.length >= 15 || !shown(el) || srOnly(el) || hiddenByAncestor(el) || fixedAncestor(el)) continue;
    if (el.closest("nav, [role=navigation], [role=dialog], dialog, [aria-modal]")) continue;
    const r = el.getBoundingClientRect();
    if (r.right < 0 || r.left > vw) offscreen.push({ selector: cssPath(el), text: text(el), rect: rect(el) });
  }

  // Touch targets below the WCAG 2.2 (2.5.8) minimum of 24×24 CSS px; inline links in running text are exempt.
  const smallTargets = [];
  for (const el of document.body.querySelectorAll("a[href],button,input:not([type=hidden]),select,[role=button]")) {
    if (smallTargets.length >= 30 || !shown(el) || srOnly(el) || hiddenByAncestor(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 24 && r.height >= 24) continue;
    if (el.tagName === "A" && el.closest("p, li") && style(el).display === "inline") continue;
    smallTargets.push({ selector: cssPath(el), text: text(el), rect: rect(el) });
  }

  const formOverflow = Array.from(document.querySelectorAll("form input:not([type=hidden]), form select, form textarea, form button"))
    .filter((el) => shown(el) && (el.getBoundingClientRect().right > vw + 1 || el.getBoundingClientRect().left < -1))
    .slice(0, 20).map((el) => ({ selector: cssPath(el), rect: rect(el) }));

  return {
    viewport: { width: vw, height: vh },
    doc: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
    overflow, images, clipped, covered, outsideContainer, groups,
    header: headerEl && shown(headerEl) ? { selector: cssPath(headerEl), rect: rect(headerEl), fixed: ["fixed", "sticky"].includes(style(headerEl).position) } : null,
    footer, navLinkRows: navTops.size, visibleNavLinks: navLinks.length, menuToggleVisible: toggle,
    offscreen, smallTargets, formOverflow,
  };
}`;

/** Scrolls through the page so lazily loaded images and content are triggered, then returns to the top. */
const AUTOSCROLL_SCRIPT = String.raw`async () => {
  const step = Math.max(200, window.innerHeight * 0.8);
  for (let y = 0; y < document.documentElement.scrollHeight && y < 30000; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 200));
  return true;
}`;

export async function measureLayout(page: Page, options: { autoscroll?: boolean } = {}): Promise<LayoutMeasurement> {
  if (options.autoscroll !== false) {
    await runScript(page, AUTOSCROLL_SCRIPT).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  }
  return runScript<LayoutMeasurement>(page, LAYOUT_SCRIPT);
}

// ---------------------------------------------------------------- analysis (pure, unit-tested)

export type LayoutCheckKey =
  | "horizontal-overflow"
  | "broken-images"
  | "missing-image-source"
  | "distorted-images"
  | "clipped-text"
  | "clipped-controls"
  | "overlapping-elements"
  | "content-outside-container"
  | "grid-consistency"
  | "alignment"
  | "spacing"
  | "header"
  | "footer"
  | "mobile-navigation"
  | "offscreen-content"
  | "touch-targets"
  | "form-fit";

export interface LayoutIssue {
  check: LayoutCheckKey;
  selector: string;
  text: string;
  message: string;
  observed: Record<string, unknown>;
}

export interface LayoutCheckDefinition {
  key: LayoutCheckKey;
  title: string;
  expected: string;
  /** FAIL when the measurement itself proves a defect; WARNING when it needs human review. */
  severity: "FAIL" | "WARNING";
  expectationSource: ExpectationSource;
  mobileOnly?: boolean;
}

export const LAYOUT_CHECKS: Record<LayoutCheckKey, LayoutCheckDefinition> = {
  "horizontal-overflow": { key: "horizontal-overflow", title: "No unexpected horizontal scrolling", expected: "Page width does not exceed the viewport (documentElement.scrollWidth ≤ clientWidth)", severity: "FAIL", expectationSource: "BROWSER_STANDARD" },
  "broken-images": { key: "broken-images", title: "Images load", expected: "Every image with a source finishes loading with non-zero natural size", severity: "FAIL", expectationSource: "BROWSER_STANDARD" },
  "missing-image-source": { key: "missing-image-source", title: "Images have a source", expected: "<img> elements declare src or srcset", severity: "WARNING", expectationSource: "BROWSER_STANDARD" },
  "distorted-images": { key: "distorted-images", title: "Images keep their aspect ratio", expected: "Rendered aspect ratio within 5% of the natural ratio (unless object-fit handles it)", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  "clipped-text": { key: "clipped-text", title: "Text is not clipped", expected: "Text fits its box when overflow is hidden (no ellipsis/line-clamp)", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  "clipped-controls": { key: "clipped-controls", title: "Button and CTA labels are fully visible", expected: "Button/CTA labels fit inside the control", severity: "FAIL", expectationSource: "DETECTED_FUNCTIONALITY" },
  "overlapping-elements": { key: "overlapping-elements", title: "Interactive elements are not covered", expected: "The centre of each link, button and field is not covered by another (non-overlay) element", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  "content-outside-container": { key: "content-outside-container", title: "Card content stays inside its card", expected: "Card/tile children stay within the card's box", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  "grid-consistency": { key: "grid-consistency", title: "Card grids are consistent", expected: "Items of one grid row have similar widths and do not overlap", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  alignment: { key: "alignment", title: "Items in a row are aligned", expected: "Items of one row start at the same top edge (or differ by more than 12px intentionally)", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  spacing: { key: "spacing", title: "Spacing between repeated items is consistent", expected: "Horizontal gaps within a row differ by at most 4px", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  header: { key: "header", title: "Header fits the viewport", expected: "The header spans the viewport width and uses at most 40% of the viewport height", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  footer: { key: "footer", title: "Footer does not overlap content", expected: "The footer starts below the main content", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  "mobile-navigation": { key: "mobile-navigation", title: "Navigation is usable on mobile", expected: "On narrow viewports navigation is reachable (links or a menu toggle) and does not wrap into more than 3 rows", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY", mobileOnly: true },
  "offscreen-content": { key: "offscreen-content", title: "Content is not positioned off-screen", expected: "Visible content is not placed entirely outside the viewport horizontally", severity: "WARNING", expectationSource: "DETECTED_FUNCTIONALITY" },
  "touch-targets": { key: "touch-targets", title: "Touch targets are at least 24×24px", expected: "Interactive targets meet the WCAG 2.2 target-size minimum (2.5.8), inline text links excepted", severity: "WARNING", expectationSource: "BROWSER_STANDARD", mobileOnly: true },
  "form-fit": { key: "form-fit", title: "Form fields fit the viewport", expected: "Inputs, selects and buttons in forms are fully within the viewport width", severity: "FAIL", expectationSource: "DETECTED_FUNCTIONALITY" },
};

const MOBILE_MAX_WIDTH = 767;

/** Turns raw measurements into evidence-backed issues. Returns issues per check (empty = check passed). */
export function analyzeLayout(m: LayoutMeasurement, checks: LayoutCheckKey[], failedImageUrls: Set<string> = new Set()): Map<LayoutCheckKey, LayoutIssue[]> {
  const out = new Map<LayoutCheckKey, LayoutIssue[]>();
  const mobile = m.viewport.width <= MOBILE_MAX_WIDTH;
  const add = (check: LayoutCheckKey, issue: Omit<LayoutIssue, "check">) => out.get(check)?.push({ check, ...issue });
  for (const c of checks) if (!LAYOUT_CHECKS[c].mobileOnly || mobile) out.set(c, []);

  if (out.has("horizontal-overflow") && m.doc.scrollWidth > m.doc.clientWidth + 1) {
    const excess = m.doc.scrollWidth - m.doc.clientWidth;
    const offenders = m.overflow.slice(0, 5);
    add("horizontal-overflow", {
      selector: offenders[0]?.selector ?? "html",
      text: offenders[0]?.text ?? "",
      message: `Page is ${excess}px wider than the ${m.doc.clientWidth}px viewport (scrollWidth ${m.doc.scrollWidth})`,
      observed: { scrollWidth: m.doc.scrollWidth, clientWidth: m.doc.clientWidth, offenders: offenders.map((o) => ({ selector: o.selector, right: o.rect.x + o.rect.w })) },
    });
  }

  for (const img of m.images) {
    if (!img.hasSrc) {
      add("missing-image-source", { selector: img.selector, text: img.alt ?? "", message: "<img> has no src or srcset", observed: { alt: img.alt } });
      continue;
    }
    if (img.complete && img.naturalWidth === 0) {
      const confirmed = failedImageUrls.has(img.src);
      add("broken-images", { selector: img.selector, text: img.alt ?? "", message: `Image failed to load: ${img.src}${confirmed ? " (request failed)" : ""}`, observed: { src: img.src, naturalWidth: 0, complete: true, requestFailed: confirmed } });
      continue;
    }
    if (img.naturalWidth > 0 && img.naturalHeight > 0 && img.rect.w > 8 && img.rect.h > 8 && !["cover", "contain", "scale-down", "none"].includes(img.objectFit)) {
      const natural = img.naturalWidth / img.naturalHeight;
      const rendered = img.rect.w / img.rect.h;
      const distortion = Math.abs(rendered - natural) / natural;
      if (distortion > 0.05) {
        add("distorted-images", { selector: img.selector, text: img.alt ?? "", message: `Rendered ${img.rect.w}×${img.rect.h} vs natural ${img.naturalWidth}×${img.naturalHeight} (${Math.round(distortion * 100)}% aspect-ratio change)`, observed: { rendered: [img.rect.w, img.rect.h], natural: [img.naturalWidth, img.naturalHeight], objectFit: img.objectFit } });
      }
    }
  }

  for (const c of m.clipped) {
    const check = c.control ? "clipped-controls" : "clipped-text";
    const hidden = c.scrollWidth > c.clientWidth + 1 ? `${c.scrollWidth - c.clientWidth}px horizontally` : `${c.scrollHeight - c.clientHeight}px vertically`;
    add(check, { selector: c.selector, text: c.text, message: `"${c.text.slice(0, 40)}" is cut off by ${hidden} (overflow ${c.overflowX}/${c.overflowY})`, observed: { scrollWidth: c.scrollWidth, clientWidth: c.clientWidth, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight } });
  }

  for (const c of m.covered) {
    add("overlapping-elements", { selector: c.selector, text: c.text, message: `"${c.text.slice(0, 40)}" is covered by ${c.coveredBy}${c.coveredByText ? ` ("${c.coveredByText.slice(0, 30)}")` : ""}`, observed: { rect: c.rect, coveredBy: c.coveredBy } });
  }

  for (const o of m.outsideContainer) {
    add("content-outside-container", { selector: o.selector, text: o.text, message: `Extends ${o.overflowPx}px outside ${o.container}`, observed: { container: o.container, overflowPx: o.overflowPx } });
  }

  for (const g of m.groups) {
    const rows = new Map<number, typeof g.items>();
    for (const item of g.items) {
      const key = [...rows.keys()].find((top) => Math.abs(top - item.rect.y) <= 12) ?? item.rect.y;
      rows.set(key, [...(rows.get(key) ?? []), item]);
    }
    for (const row of rows.values()) {
      if (row.length < 2) continue;
      const sorted = [...row].sort((a, b) => a.rect.x - b.rect.x);
      const widths = sorted.map((i) => i.rect.w);
      const maxW = Math.max(...widths);
      const minW = Math.min(...widths);
      // The last item of a wrapping row may legitimately be narrower; compare all but trailing items.
      if (maxW > 0 && (maxW - minW) / maxW > 0.1 && sorted.length >= 3) {
        add("grid-consistency", { selector: g.container, text: "", message: `Items in one row of ${g.container} range from ${minW}px to ${maxW}px wide`, observed: { widths } });
      }
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1].rect;
        const cur = sorted[i].rect;
        if (prev.x + prev.w - cur.x > 4) add("grid-consistency", { selector: sorted[i].selector, text: sorted[i].text, message: `Overlaps the previous item by ${prev.x + prev.w - cur.x}px`, observed: { previous: prev, current: cur } });
      }
      const tops = sorted.map((i) => i.rect.y);
      const spread = Math.max(...tops) - Math.min(...tops);
      if (spread >= 2 && spread <= 12) {
        add("alignment", { selector: g.container, text: "", message: `Top edges in one row differ by ${spread}px`, observed: { tops } });
      }
      if (sorted.length >= 3) {
        const gaps = sorted.slice(1).map((it, i) => it.rect.x - (sorted[i].rect.x + sorted[i].rect.w));
        const spreadGap = Math.max(...gaps) - Math.min(...gaps);
        if (gaps.every((x) => x >= 0) && spreadGap > 4) add("spacing", { selector: g.container, text: "", message: `Gaps between items vary from ${Math.min(...gaps)}px to ${Math.max(...gaps)}px`, observed: { gaps } });
      }
    }
  }

  if (out.has("header") && m.header) {
    const r = m.header.rect;
    if (r.w > m.viewport.width + 1) add("header", { selector: m.header.selector, text: "", message: `Header is ${r.w}px wide in a ${m.viewport.width}px viewport`, observed: { rect: r } });
    if (r.h > m.viewport.height * 0.4) add("header", { selector: m.header.selector, text: "", message: `Header takes ${r.h}px (${Math.round((r.h / m.viewport.height) * 100)}% of the viewport height)${m.header.fixed ? " and stays fixed while scrolling" : ""}`, observed: { rect: r, viewportHeight: m.viewport.height, fixed: m.header.fixed } });
  }
  if (out.has("footer") && m.footer && m.footer.overlapsContent > 2) {
    add("footer", { selector: m.footer.selector, text: "", message: `Footer overlaps the main content by ${m.footer.overlapsContent}px`, observed: { overlapPx: m.footer.overlapsContent } });
  }
  if (out.has("mobile-navigation")) {
    if (m.visibleNavLinks === 0 && !m.menuToggleVisible) add("mobile-navigation", { selector: "nav", text: "", message: "No navigation link or menu toggle is visible", observed: { visibleNavLinks: 0 } });
    if (m.navLinkRows > 3) add("mobile-navigation", { selector: "nav", text: "", message: `Navigation links wrap into ${m.navLinkRows} rows`, observed: { rows: m.navLinkRows } });
  }
  for (const o of m.offscreen) add("offscreen-content", { selector: o.selector, text: o.text, message: `Positioned at x=${o.rect.x} outside the ${m.viewport.width}px viewport`, observed: { rect: o.rect } });
  for (const t of m.smallTargets) add("touch-targets", { selector: t.selector, text: t.text, message: `Target is ${t.rect.w}×${t.rect.h}px`, observed: { rect: t.rect } });
  for (const f of m.formOverflow) add("form-fit", { selector: f.selector, text: "", message: `Form control spans x=${f.rect.x}…${f.rect.x + f.rect.w} beyond the ${m.viewport.width}px viewport`, observed: { rect: f.rect } });
  return out;
}

export const UI_CHECKS: LayoutCheckKey[] = [
  "horizontal-overflow", "broken-images", "missing-image-source", "distorted-images", "clipped-text", "clipped-controls", "overlapping-elements",
  "content-outside-container", "grid-consistency", "alignment", "spacing", "header", "footer", "mobile-navigation", "offscreen-content",
];

export const RESPONSIVE_CHECKS: LayoutCheckKey[] = [
  "horizontal-overflow", "clipped-controls", "clipped-text", "distorted-images", "overlapping-elements", "grid-consistency", "header", "mobile-navigation", "touch-targets", "form-fit",
];
