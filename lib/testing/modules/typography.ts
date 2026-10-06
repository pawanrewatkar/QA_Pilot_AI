import type { Page } from "playwright";
import { resolveRunOptions, type TypographyMode } from "@/types";
import { runScript } from "../browser-scripts";
import type { TestModule } from "../context";
import { detail, type DetailRow } from "../details";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { spec } from "./helpers";

export type TypographyRole = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "paragraph" | "link" | "button" | "cta" | "label" | "navigation";

export interface TypographySample {
  role: TypographyRole;
  tag: string;
  section: string;
  selector: string;
  text: string;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
  box: { w: number; h: number };
}

/** Up to `perRole` visible samples for each typographic role, with computed styles. */
const TYPOGRAPHY_SCRIPT = String.raw`(perRole) => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
  const text = (el) => (el.innerText || el.textContent || el.getAttribute("value") || "").replace(/\s+/g, " ").trim();
  const section = (el) => el.closest("header, [role=banner]") ? "Header" : el.closest("nav, [role=navigation]") ? "Navigation" : el.closest("footer, [role=contentinfo]") ? "Footer" : el.closest("aside") ? "Sidebar" : "Main";
  const path = (el) => { const parts = []; let n = el; for (let i = 0; n && n.nodeType === 1 && i < 3; i++) { let p = n.tagName.toLowerCase(); if (n.id) { parts.unshift(p + "#" + n.id); break; } const c = (typeof n.className === "string" ? n.className : "").trim().split(/\s+/).filter(Boolean)[0]; if (c) p += "." + c; parts.unshift(p); n = n.parentElement; } return parts.join(" > "); };
  const isCta = (el) => /btn|button|cta/i.test(typeof el.className === "string" ? el.className : "");
  const roles = [
    ["h1", "h1"], ["h2", "h2"], ["h3", "h3"], ["h4", "h4"], ["h5", "h5"], ["h6", "h6"],
    ["paragraph", "main p, article p, body > p, section p"],
    ["link", "main a[href], article a[href], section a[href], p a[href]"],
    ["button", "button, input[type=submit], input[type=button]"],
    ["cta", "a[class*=btn i], a[class*=button i], a[class*=cta i], [role=button]"],
    ["label", "label"],
    ["navigation", "nav a[href], [role=navigation] a[href], header a[href]"],
  ];
  const out = [];
  const seen = new Set();
  for (const [role, selector] of roles) {
    let count = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (count >= perRole) break;
      if (seen.has(el) || !shown(el)) continue;
      if (role === "link" && (isCta(el) || el.closest("nav"))) continue;
      const t = text(el);
      if (!t) continue;
      seen.add(el);
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.push({ role, tag: el.tagName.toLowerCase(), section: section(el), selector: path(el), text: t.slice(0, 160),
        fontFamily: s.fontFamily, fontSizePx: parseFloat(s.fontSize), fontWeight: s.fontWeight, lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing, color: s.color, box: { w: Math.round(r.width), h: Math.round(r.height) } });
      count++;
    }
  }
  return out;
}`;

export function collectTypography(page: Page, perRole = 8): Promise<TypographySample[]> {
  return runScript<TypographySample[]>(page, TYPOGRAPHY_SCRIPT, perRole);
}

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
const MIN_READABLE_PX = 12;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Pure checks over measured samples (no external expectations involved). */
export function analyzeTypography(samples: TypographySample[]) {
  const tooSmall = samples.filter((s) => s.fontSizePx > 0 && s.fontSizePx < MIN_READABLE_PX);
  const inconsistent: { tag: string; variants: string[] }[] = [];
  for (const h of HEADINGS) {
    const main = samples.filter((s) => s.role === h && s.section === "Main");
    const variants = [...new Set(main.map((s) => `${s.fontFamily.split(",")[0].replace(/["']/g, "")} ${s.fontSizePx}px/${s.fontWeight}`))];
    if (variants.length > 1) inconsistent.push({ tag: h, variants });
  }
  const inversions: { higher: string; lower: string; higherPx: number; lowerPx: number }[] = [];
  const present = HEADINGS.filter((h) => samples.some((s) => s.role === h));
  for (let i = 1; i < present.length; i++) {
    const higher = median(samples.filter((s) => s.role === present[i - 1]).map((s) => s.fontSizePx));
    const lower = median(samples.filter((s) => s.role === present[i]).map((s) => s.fontSizePx));
    if (lower > higher) inversions.push({ higher: present[i - 1], lower: present[i], higherPx: higher, lowerPx: lower });
  }
  return { tooSmall, inconsistent, inversions };
}

function typographyRows(samples: TypographySample[], mode: TypographyMode, browser: string, viewport: string): DetailRow[] {
  const withTags = mode !== "TYPOGRAPHY_ONLY";
  const withText = mode === "TYPOGRAPHY_CONTENT" || mode === "COMPLETE_UI";
  const rows: DetailRow[] = samples.map((s) =>
    detail("typography_results", {
      selector: s.selector,
      font_family: s.fontFamily,
      font_size_px: s.fontSizePx,
      font_weight: s.fontWeight,
      line_height: s.lineHeight,
      letter_spacing: s.letterSpacing,
      color: s.color,
      // No Figma or document typography is available, so no expected value or difference is recorded.
      expected: null,
      expected_source: null,
      difference: null,
      status: "NOT EXECUTED",
      browser,
      viewport,
      section: s.section,
      role: s.role,
      tag: withTags ? s.tag : null,
      text_content: withText ? s.text : null,
    }),
  );
  if (mode === "COMPLETE_UI") {
    for (const s of samples) {
      rows.push(detail("ui_results", { category: "UI", check_key: "element-metrics", selector: s.selector, browser, viewport, observed: JSON.stringify({ role: s.role, tag: s.tag, box: s.box, color: s.color }), message: "Measured element box", status: null, element_text: s.text }));
    }
  }
  return rows;
}

export const typographyModule: TestModule = {
  id: "typography",
  scope: "combo",
  async run(ctx) {
    const { typographyMode } = resolveRunOptions(ctx.options);
    const samples = await collectTypography(ctx.session.page);
    const base = (key: string, title: string, expected: string, source: "FIGMA" | "DETECTED_FUNCTIONALITY" | "BROWSER_STANDARD" = "DETECTED_FUNCTIONALITY") =>
      spec("typography", key, {
        title,
        section: "Typography",
        feature: "Typography",
        element: "headings, paragraphs, links, buttons, CTAs, labels, navigation",
        steps: ["Render the page", "Read computed font family, size, weight, line height, letter spacing and colour"],
        expected,
        expectationSource: source,
      });
    if (!samples.length) return [outcome.notApplicable(base("inventory", "Typography inventory", "Text elements present"), "No visible text elements were found.")];

    const results: CheckOutcome[] = [];
    const roles = [...new Set(samples.map((s) => s.role))];
    results.push({
      ...outcome.notExecuted(
        base("reference", "Typography matches the design reference", "Font family, size, weight, line height and letter spacing equal the Figma/reference values", "FIGMA"),
        `No Figma or reference typography is available, so no expected values exist and none were invented. ${samples.length} elements were measured (${roles.join(", ")}; mode: ${typographyMode.replace(/_/g, " ").toLowerCase()}) and stored for review and future comparison.`,
      ),
      details: typographyRows(samples, typographyMode, ctx.browser, ctx.viewport.id),
    });

    const { tooSmall, inconsistent, inversions } = analyzeTypography(samples);
    const small = base("min-size", `Text is at least ${MIN_READABLE_PX}px`, `Readability guideline: rendered text is ${MIN_READABLE_PX}px or larger (review item, not a project requirement)`);
    results.push(
      tooSmall.length
        ? outcome.warn(small, `${tooSmall.length} element(s) below ${MIN_READABLE_PX}px, e.g. "${tooSmall[0].text.slice(0, 40)}" at ${tooSmall[0].fontSizePx}px`, {
            evidence: [evidence.dom("Small text", tooSmall.slice(0, 20).map((s) => `${s.selector} (${s.role}): ${s.fontSizePx}px — "${s.text.slice(0, 50)}"`).join("\n"))],
          })
        : outcome.pass(small, `Smallest measured text: ${Math.min(...samples.map((s) => s.fontSizePx))}px`, [`${samples.length} elements measured`]),
    );

    const consistent = base("heading-consistency", "Each heading level is styled consistently", "All main-content headings of the same level share font family, size and weight");
    results.push(
      inconsistent.length
        ? outcome.warn(consistent, inconsistent.map((i) => `${i.tag.toUpperCase()}: ${i.variants.join(" | ")}`).join("; "), { evidence: [evidence.dom("Heading variants", JSON.stringify(inconsistent, null, 2))] })
        : outcome.pass(consistent, "Each heading level uses one style", [`${HEADINGS.filter((h) => samples.some((s) => s.role === h)).length} heading level(s) compared`]),
    );

    const order = base("heading-scale", "Heading sizes follow the heading levels", "A higher heading level is not rendered smaller than a lower level");
    const headingLevels = HEADINGS.filter((h) => samples.some((s) => s.role === h)).length;
    results.push(
      headingLevels < 2
        ? outcome.notApplicable(order, "Fewer than two heading levels are present.")
        : inversions.length
          ? outcome.warn(order, inversions.map((i) => `${i.lower.toUpperCase()} (${i.lowerPx}px) is larger than ${i.higher.toUpperCase()} (${i.higherPx}px)`).join("; "), { evidence: [evidence.dom("Median heading sizes", JSON.stringify(inversions))] })
          : outcome.pass(order, "Heading sizes decrease with level", [`${headingLevels} levels compared by median font size`]),
    );
    return results;
  },
};
