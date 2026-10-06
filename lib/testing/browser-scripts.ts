import type { Page } from "playwright";

/**
 * Browser-side scripts are plain JavaScript strings. Functions passed to page.evaluate would be
 * transpiled by tsx/esbuild with helpers (e.g. `__name`) that do not exist inside the page.
 */
export async function runScript<T>(page: Page, fnSource: string, arg?: unknown): Promise<T> {
  return (await page.evaluate(`(${fnSource})(${JSON.stringify(arg ?? null)})`)) as T;
}

export const qapSelector = (qid: string) => `[data-qap="${qid}"]`;

export interface InspectedLink {
  qid: string;
  href: string;
  rawHref: string;
  text: string;
  source: string;
  rel: string;
  target: string;
  download: boolean;
  visible: boolean;
}

export interface InspectedToggle {
  qid: string;
  text: string;
  controls: string | null;
  expanded: string | null;
  haspopup: string | null;
  visible: boolean;
  /** True when the element declares its behaviour through ARIA (strong evidence of intent). */
  strong: boolean;
}

export interface InspectedSelect {
  qid: string;
  name: string;
  label: string;
  options: { value: string; text: string; disabled: boolean }[];
  selectedIndex: number;
  isSort: boolean;
  inForm: boolean;
  visible: boolean;
}

export interface InspectedTab {
  qid: string;
  label: string;
  selected: boolean;
  controls: string | null;
}

export interface InspectedCarousel {
  qid: string;
  nextQid: string | null;
  prevQid: string | null;
  slideCount: number;
  strong: boolean;
}

export interface InspectedCta {
  qid: string;
  tag: string;
  text: string;
  href: string | null;
  type: string | null;
  visible: boolean;
}

export interface InspectedSearch {
  inputQid: string;
  formQid: string | null;
  submitQid: string | null;
  method: string;
  name: string;
  visible: boolean;
}

export interface Inspection {
  h1: string;
  title: string;
  navContainers: number;
  links: InspectedLink[];
  menuToggles: InspectedToggle[];
  selects: InspectedSelect[];
  popupToggles: InspectedToggle[];
  tablists: InspectedTab[][];
  details: { summaryQid: string; detailsQid: string; open: boolean; text: string; visible: boolean }[];
  accordions: InspectedToggle[];
  modalTriggers: InspectedToggle[];
  carousels: InspectedCarousel[];
  searches: InspectedSearch[];
  pagination: { nextQid: string | null; nextHref: string | null; pageLinks: number }[];
  breadcrumbs: { qid: string; items: { text: string; href: string | null; current: boolean }[] }[];
  ctas: InspectedCta[];
  filters: { qid: string; kind: string; text: string; visible: boolean }[];
  searchTerm: string | null;
}

/** Tags interactive elements with `data-qap` ids (deterministic DOM order) and describes them. */
export const INSPECT_SCRIPT = String.raw`() => {
  let counter = 0;
  const tag = (el, prefix) => {
    if (!el.getAttribute("data-qap")) el.setAttribute("data-qap", prefix + "-" + (counter++));
    return el.getAttribute("data-qap");
  };
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 120) : "");
  const label = (el) => txt(el) || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value") || "";
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const sourceOf = (el) => {
    if (el.closest('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, [itemtype*="BreadcrumbList"]')) return "breadcrumb";
    if (/\b(next|prev)\b/i.test(el.getAttribute("rel") || "") || el.closest('.pagination, .pager, [aria-label*="pagination" i]')) return "pagination";
    if (el.closest('footer, [role="contentinfo"]')) return "footer";
    if (el.closest('nav, [role="navigation"], [role="menubar"], [role="menu"]')) return "navigation";
    if (el.closest('header, [role="banner"]')) return "header";
    const cls = (el.getAttribute("class") || "").toLowerCase();
    if (el.getAttribute("role") === "button" || /(^|[\s_-])(btn|button|cta)([\s_-]|$)/.test(cls)) return "cta";
    return "content";
  };
  const isMenuToggle = (el) => {
    const s = ((el.getAttribute("class") || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.id || "") + " " + txt(el)).toLowerCase();
    return /hamburger|navbar-toggler|menu-toggle|nav-toggle|mobile-menu|toggle navigation|open menu|menu-button|burger/.test(s) || (/\bmenu\b/.test(s) && !!el.closest("header, nav, [role=banner]"));
  };

  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const raw = a.getAttribute("href") || "";
    links.push({ qid: tag(a, "a"), href: a.href, rawHref: raw, text: label(a).slice(0, 120), source: sourceOf(a),
      rel: a.getAttribute("rel") || "", target: a.getAttribute("target") || "", download: a.hasAttribute("download"), visible: visible(a) });
  }

  const toggleInfo = (el, strong) => ({ qid: tag(el, "t"), text: label(el), controls: el.getAttribute("aria-controls"),
    expanded: el.getAttribute("aria-expanded"), haspopup: el.getAttribute("aria-haspopup"), visible: visible(el), strong });

  const menuToggles = [];
  const popupToggles = [];
  const accordions = [];
  const modalTriggers = [];
  const used = new Set();
  for (const el of document.querySelectorAll('button, [role="button"], a[href^="#"], [aria-expanded], [data-toggle], [data-bs-toggle]')) {
    if (el.closest('[role="tablist"]') || el.tagName === "SUMMARY") continue;
    const dt = (el.getAttribute("data-bs-toggle") || el.getAttribute("data-toggle") || "").toLowerCase();
    const popup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
    const href = el.getAttribute("href") || "";
    const targetId = (el.getAttribute("aria-controls") || el.getAttribute("data-bs-target") || el.getAttribute("data-target") || (href.length > 1 ? href : "")).replace(/^#/, "");
    let target = null;
    try { target = targetId ? document.getElementById(targetId) : null; } catch (e) {}
    const targetIsDialog = !!(target && (target.getAttribute("role") === "dialog" || target.tagName === "DIALOG" || target.getAttribute("aria-modal") === "true" || /\bmodal\b/.test(target.className || "")));
    if (popup === "dialog" || dt === "modal" || targetIsDialog) { modalTriggers.push(toggleInfo(el, popup === "dialog" || targetIsDialog)); used.add(el); continue; }
    if (isMenuToggle(el) && (el.hasAttribute("aria-expanded") || el.tagName === "BUTTON")) { menuToggles.push(toggleInfo(el, el.hasAttribute("aria-expanded"))); used.add(el); continue; }
    if (popup === "menu" || popup === "listbox" || popup === "true" || dt === "dropdown") { popupToggles.push(toggleInfo(el, !!popup)); used.add(el); continue; }
    if (el.hasAttribute("aria-expanded") && el.getAttribute("aria-controls") && target) { accordions.push(toggleInfo(el, true)); used.add(el); continue; }
    if (dt === "collapse") { accordions.push(toggleInfo(el, false)); used.add(el); }
  }

  const selects = [];
  for (const s of document.querySelectorAll("select")) {
    const lab = (s.id && document.querySelector('label[for="' + CSS.escape(s.id) + '"]')) || s.closest("label");
    const meta = ((s.name || "") + " " + (s.id || "") + " " + (lab ? txt(lab) : "") + " " + (s.getAttribute("aria-label") || "")).toLowerCase();
    selects.push({ qid: tag(s, "s"), name: s.name || s.id || "", label: (lab ? txt(lab) : s.getAttribute("aria-label") || s.name || "").slice(0, 80),
      options: Array.from(s.options).map((o) => ({ value: o.value, text: o.text.trim().slice(0, 80), disabled: o.disabled })),
      selectedIndex: s.selectedIndex, isSort: /sort|order ?by|orderby/.test(meta), inForm: !!s.closest("form"), visible: visible(s) });
  }

  const tablists = [];
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = Array.from(list.querySelectorAll('[role="tab"]')).map((t) => ({ qid: tag(t, "tab"), label: label(t),
      selected: t.getAttribute("aria-selected") === "true", controls: t.getAttribute("aria-controls") }));
    if (tabs.length >= 2) tablists.push(tabs);
  }

  const details = [];
  for (const d of document.querySelectorAll("details")) {
    const summary = d.querySelector("summary");
    if (!summary) continue;
    details.push({ summaryQid: tag(summary, "sum"), detailsQid: tag(d, "det"), open: d.open, text: txt(summary), visible: visible(summary) });
  }

  const carousels = [];
  const carouselRoots = document.querySelectorAll('[aria-roledescription="carousel" i], .carousel, .swiper, .slick-slider, .splide, .glide, [data-carousel], .owl-carousel, .flickity-enabled');
  const seenRoots = new Set();
  for (const root of carouselRoots) {
    if ([...seenRoots].some((r) => r.contains(root))) continue;
    seenRoots.add(root);
    const find = (re, sel) => root.querySelector(sel) || Array.from(root.querySelectorAll("button, [role=button], a")).find((b) => re.test(((b.getAttribute("aria-label") || "") + " " + (b.className || "") + " " + txt(b)).toLowerCase()));
    const next = find(/next|forward|›|»|→/, ".swiper-button-next, .slick-next, .carousel-control-next, .splide__arrow--next, .glide__arrow--right, [data-slide=next], [data-bs-slide=next]");
    const prev = find(/prev|previous|back|‹|«|←/, ".swiper-button-prev, .slick-prev, .carousel-control-prev, .splide__arrow--prev, .glide__arrow--left, [data-slide=prev], [data-bs-slide=prev]");
    const slides = root.querySelectorAll('[aria-roledescription="slide" i], .carousel-item, .swiper-slide, .slick-slide:not(.slick-cloned), .splide__slide, .glide__slide, [data-slide-index]');
    carousels.push({ qid: tag(root, "car"), nextQid: next ? tag(next, "carn") : null, prevQid: prev ? tag(prev, "carp") : null, slideCount: slides.length,
      strong: root.getAttribute("aria-roledescription") === "carousel" || slides.length >= 2 });
  }

  const searches = [];
  for (const input of document.querySelectorAll('input[type="search"], [role="search"] input:not([type=hidden]):not([type=submit]), input[name="q"], input[name="s"], input[name="search"], input[name="query"], input[name="keyword"]')) {
    if (input.type === "hidden" || input.type === "password") continue;
    const form = input.closest("form");
    const submit = form ? form.querySelector('button[type="submit"], input[type="submit"], button:not([type])') : null;
    searches.push({ inputQid: tag(input, "srch"), formQid: form ? tag(form, "f") : null, submitQid: submit ? tag(submit, "srchb") : null,
      method: form ? (form.getAttribute("method") || "get").toLowerCase() : "none", name: input.name || "", visible: visible(input) });
  }

  const pagination = [];
  for (const p of document.querySelectorAll('.pagination, .pager, nav[aria-label*="pagination" i], [role="navigation"][aria-label*="pagination" i]')) {
    const next = p.querySelector('a[rel="next"], a[aria-label*="next" i], .next a, a.next') || Array.from(p.querySelectorAll("a[href]")).find((a) => /next|›|»/i.test(txt(a)));
    pagination.push({ nextQid: next ? tag(next, "pgn") : null, nextHref: next ? next.href : null, pageLinks: p.querySelectorAll("a[href]").length });
  }
  if (!pagination.length) {
    const relNext = document.querySelector('a[rel="next"]');
    if (relNext) pagination.push({ nextQid: tag(relNext, "pgn"), nextHref: relNext.href, pageLinks: 1 });
  }

  const breadcrumbs = [];
  for (const b of document.querySelectorAll('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, [itemtype*="BreadcrumbList"]')) {
    if (breadcrumbs.length && b.closest("[data-qap^=bc]")) continue;
    const items = Array.from(b.querySelectorAll("li, [itemprop=itemListElement]")).map((li) => {
      const a = li.querySelector("a[href]");
      return { text: txt(li), href: a ? a.href : null, current: li.getAttribute("aria-current") === "page" || !!li.querySelector('[aria-current="page"]') };
    }).filter((i) => i.text);
    if (items.length) breadcrumbs.push({ qid: tag(b, "bc"), items });
  }

  const ctas = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"], input[type="button"]')) {
    if (used.has(el) || el.closest("form, nav, header, footer, [role=navigation], [role=tablist], [role=dialog], dialog") || el.tagName === "SUMMARY") continue;
    const cls = (el.getAttribute("class") || "").toLowerCase();
    const isButton = el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.tagName === "INPUT";
    const isCtaLink = el.tagName === "A" && /(^|[\s_-])(btn|button|cta)([\s_-]|$)/.test(cls);
    if (!isButton && !isCtaLink) continue;
    ctas.push({ qid: tag(el, "cta"), tag: el.tagName.toLowerCase(), text: label(el), href: el.tagName === "A" ? el.href : null, type: el.getAttribute("type"), visible: visible(el) });
  }

  const filters = [];
  for (const area of document.querySelectorAll('[class*="filter" i], [aria-label*="filter" i], [id*="filter" i], [class*="facet" i]')) {
    for (const el of area.querySelectorAll('input[type="checkbox"], input[type="radio"], a[href*="?"], button')) {
      if (el.closest("[data-qap-filter-done]")) continue;
      filters.push({ qid: tag(el, "flt"), kind: el.tagName === "INPUT" ? el.type : el.tagName.toLowerCase(), text: label(el) || (el.closest("label") ? txt(el.closest("label")) : ""), visible: visible(el) });
    }
    area.setAttribute("data-qap-filter-done", "1");
  }

  const words = (txt(document.querySelector("h1")) + " " + Array.from(document.querySelectorAll("nav a")).map(txt).join(" ")).split(/\s+/).filter((w) => /^[A-Za-z]{4,}$/.test(w));

  return {
    h1: txt(document.querySelector("h1")),
    title: document.title || "",
    navContainers: document.querySelectorAll('nav, [role="navigation"]').length,
    links, menuToggles, selects, popupToggles, tablists, details, accordions, modalTriggers, carousels, searches, pagination, breadcrumbs, ctas, filters,
    searchTerm: words.length ? words[0].toLowerCase() : null,
  };
}`;

/** A compact signature of visible state inside an element, used to detect real state changes. */
export const STATE_SIGNATURE_SCRIPT = String.raw`(qid) => {
  const root = document.querySelector('[data-qap="' + qid + '"]');
  if (!root) return null;
  // Position-aware: "slide 1 active" and "slide 2 active" must produce different signatures.
  const parts = [];
  let index = 0;
  for (const el of root.querySelectorAll("*")) {
    index++;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const shown = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    const cls = typeof el.className === "string" ? el.className : "";
    if (/active|current|selected|is-active|show/.test(cls) || el.getAttribute("aria-hidden") !== null || el.getAttribute("aria-current") !== null) {
      parts.push(index + ":" + el.tagName + ":" + cls + ":" + el.getAttribute("aria-hidden") + ":" + el.getAttribute("aria-current") + ":" + (shown ? 1 : 0));
    }
    if (s.transform && s.transform !== "none") parts.push(index + ":tf:" + s.transform);
    if (el.scrollLeft) parts.push(index + ":sl:" + Math.round(el.scrollLeft));
  }
  parts.push("text:" + (root.innerText || "").replace(/\s+/g, " ").slice(0, 2000));
  return parts.join("|").slice(0, 30000);
}`;

/** Number of visible links / open dialogs on the page. */
export const PAGE_STATE_SCRIPT = String.raw`() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
  return {
    visibleLinks: Array.from(document.querySelectorAll("a[href]")).filter(shown).length,
    openDialogs: Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"], .modal')).filter((d) => shown(d) || d.open === true).length,
    url: location.href,
  };
}`;
