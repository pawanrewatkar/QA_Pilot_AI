import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareContent, isSpellingOnly, normalizeText, similarity, wordDiff } from "@/lib/content/compare";
import { blocksFromHtml, blocksFromMarkdown, blocksFromPlainText, extractReferenceContent } from "@/lib/content/document";
import type { ContentBlock } from "@/lib/content/types";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { NotConfiguredFigmaProvider, RestFigmaProvider } from "@/lib/figma/provider";
import { measurementFromLhr } from "@/lib/performance/lighthouse-provider";
import type { PerformanceMeasurement } from "@/lib/performance/provider";
import { rateMetric, rateScore, ratingToStatus } from "@/lib/performance/ratings";
import { detail } from "@/lib/testing/details";
import { analyzeLayout, type LayoutMeasurement } from "@/lib/testing/layout";
import { AUTOMATED_DISCLAIMER, axeToOutcomes } from "@/lib/testing/modules/accessibility";
import { hasEcommerce, PURCHASE_ACTION, type EcomSignals } from "@/lib/testing/modules/ecommerce";
import { createFigmaModule } from "@/lib/testing/modules/figma";
import { analyzeNetwork } from "@/lib/testing/modules/observability";
import { performanceOutcomes } from "@/lib/testing/modules/performance";
import { analyzeSeo, findDuplicates, type SeoSnapshot } from "@/lib/testing/modules/seo";
import { analyzeTypography, type TypographySample } from "@/lib/testing/modules/typography";
import { finalizeOutcome, outcome, type CaseSpec } from "@/lib/testing/outcome";
import { resolveRunOptions } from "@/types";
import { makeDocx, makePdf } from "./fixtures/make-docs";
import { createTestDb, projectInput } from "./helpers";

// ---------------------------------------------------------------- content comparison

const h = (text: string, level: number | null = 2): ContentBlock => ({ kind: "heading", level, text });
const p = (text: string): ContentBlock => ({ kind: "paragraph", level: null, text });

describe("content extraction", () => {
  it("reads headings and paragraphs from a real DOCX", async () => {
    const doc = await extractReferenceContent({ documentId: "d1", fileName: "spec.docx", bytes: makeDocx([["Heading1", "About Us"], ["Normal", "We build reliable tools."], ["Heading2", "Mission"], ["Normal", "Ship faster."]]) });
    expect(doc).toMatchObject({ format: "docx", structuredHeadings: true });
    expect(doc.blocks).toEqual([h("About Us", 1), p("We build reliable tools."), h("Mission", 2), p("Ship faster.")]);
  });

  it("reads text from a real PDF, inferring headings", async () => {
    const doc = await extractReferenceContent({ documentId: "d2", fileName: "spec.pdf", bytes: makePdf(["Our Mission", "We help teams ship quality software faster."]) });
    expect(doc).toMatchObject({ format: "pdf", structuredHeadings: false });
    expect(doc.blocks).toEqual([h("Our Mission", null), p("We help teams ship quality software faster.")]);
  });

  it("parses Markdown, HTML and plain text", () => {
    expect(blocksFromMarkdown("# Title\n\nFirst line\nsecond line\n\n- item one\n## Sub")).toEqual([h("Title", 1), p("First line second line"), { kind: "list-item", level: null, text: "item one" }, h("Sub", 2)]);
    expect(blocksFromHtml("<h2>A &amp; B</h2><p>Text <strong>bold</strong></p><li>x</li>")).toEqual([h("A & B", 2), p("Text bold"), { kind: "list-item", level: null, text: "x" }]);
    expect(blocksFromPlainText("Section Title\nA wrapped line that\ncontinues here.\n\n• bullet")).toEqual([h("Section Title", null), p("A wrapped line that continues here."), { kind: "list-item", level: null, text: "bullet" }]);
  });

  it("rejects unsupported formats", async () => {
    await expect(extractReferenceContent({ documentId: "d", fileName: "x.xlsx", bytes: new Uint8Array([1]) })).rejects.toThrow(/not supported/);
  });
});

describe("content comparison", () => {
  it("normalises quotes, dashes and whitespace", () => {
    expect(normalizeText("“Hello”  —  world’s", true)).toBe('"Hello" - world\'s');
    expect(similarity("the quick brown fox", "the quick brown fox")).toBe(1);
    expect(similarity("the quick brown fox", "a slow green turtle")).toBe(0);
    expect(wordDiff("two enginers", "two engineers")).toEqual({ missingWords: ["enginers"], extraWords: ["engineers"] });
    expect(isSpellingOnly("founded by two engineers", "founded by two enginers")).toBe(true);
    expect(isSpellingOnly("founded by two engineers", "founded by three designers")).toBe(false);
  });

  const reference = {
    structuredHeadings: true,
    blocks: [
      h("About Fixture Co", 1),
      p("Fixture Co builds reliable testing tools for modern teams."),
      h("Our mission"),
      p("We help teams ship quality software faster with automated checks."),
      h("Our history"),
      p("The company was founded in 2015 by two engineers in Berlin."),
      p("Today we serve customers in more than forty countries."),
    ],
  };
  const page = {
    blocks: [
      h("About Fixture Co", 1),
      p("Fixture Co builds reliable testing tools for modern teams."),
      h("Our mission", 3),
      p("We help teams ship quality software faster with automated checks."),
      h("Our history"),
      p("The company was founded in 2015 by two enginers in Berlin."),
      p("We are hiring talented people in every department right now."),
      p("We are hiring talented people in every department right now."),
    ],
    ctas: ["Book a demo"],
  };

  it("section mode finds missing, spelling, heading, extra, repeated and CTA differences", () => {
    const r = compareContent(reference, page, "SECTION");
    const kinds = (k: string) => r.findings.filter((f) => f.kind === k);
    expect(r.relevant).toBe(true);
    expect(kinds("MISSING").map((f) => f.expected)).toEqual(["Today we serve customers in more than forty countries."]);
    expect(kinds("SPELLING")[0]).toMatchObject({ section: "Our history", expected: "The company was founded in 2015 by two engineers in Berlin." });
    expect(kinds("HEADING")[0]).toMatchObject({ message: "Heading level differs: reference H2, page H3" });
    expect(kinds("EXTRA")).toHaveLength(2);
    expect(kinds("REPEATED")[0].message).toBe("Repeated 2 times on the page");
    expect(kinds("CTA")[0].actual).toBe("Book a demo");
    expect(r.findings.every((f) => f.mode === "SECTION")).toBe(true);
  });

  it("exact mode is case-sensitive and detects reordering", () => {
    const ref = { structuredHeadings: false, blocks: [p("First paragraph of text here."), p("Second paragraph of text here."), p("Third paragraph of text here.")] };
    const r = compareContent(ref, { blocks: [p("Third paragraph of text here."), p("First paragraph of text here."), p("second paragraph of text here.")], ctas: [] }, "EXACT");
    expect(r.findings.some((f) => f.kind === "CHANGED" && f.message.includes("capitalisation"))).toBe(true);
    expect(r.findings.some((f) => f.kind === "ORDER")).toBe(true);
  });

  it("does not compare a page that does not correspond to the document", () => {
    const r = compareContent(reference, { blocks: [h("Shop", 1), p("Widgets and gadgets for sale at great prices.")], ctas: ["Add to cart"] }, "SECTION");
    expect(r.relevant).toBe(false);
    expect(r.findings.some((f) => f.kind === "EXTRA" || f.kind === "CTA")).toBe(false);
  });
});

// ---------------------------------------------------------------- UI measurement

const measurement = (over: Partial<LayoutMeasurement> = {}): LayoutMeasurement => ({
  viewport: { width: 1440, height: 900 },
  doc: { scrollWidth: 1440, clientWidth: 1440 },
  overflow: [], images: [], clipped: [], covered: [], outsideContainer: [], groups: [],
  header: null, footer: null, navLinkRows: 1, visibleNavLinks: 5, menuToggleVisible: false, offscreen: [], smallTargets: [], formOverflow: [],
  ...over,
});
const rect = (x: number, y: number, w: number, hh: number) => ({ x, y, w, h: hh });

describe("UI measurement analysis", () => {
  it("reports horizontal overflow only when the document is wider than the viewport", () => {
    expect(analyzeLayout(measurement(), ["horizontal-overflow"]).get("horizontal-overflow")).toEqual([]);
    const issues = analyzeLayout(measurement({ doc: { scrollWidth: 2400, clientWidth: 1440 }, overflow: [{ selector: "div.banner", text: "x", rect: rect(0, 0, 2400, 20) }] }), ["horizontal-overflow"]).get("horizontal-overflow")!;
    expect(issues[0]).toMatchObject({ selector: "div.banner", message: expect.stringContaining("960px wider") });
  });

  it("classifies images: broken, missing source, distorted, and respects object-fit", () => {
    const img = (o: object) => ({ selector: "img", src: "/a.png", hasSrc: true, complete: true, lazy: false, naturalWidth: 200, naturalHeight: 100, rect: rect(0, 0, 200, 100), objectFit: "fill", alt: "a", ...o });
    const r = analyzeLayout(
      measurement({ images: [img({ naturalWidth: 0, naturalHeight: 0, src: "/missing.png" }), img({ hasSrc: false }), img({ rect: rect(0, 0, 100, 100) }), img({ rect: rect(0, 0, 100, 100), objectFit: "cover" }), img({})] }),
      ["broken-images", "missing-image-source", "distorted-images"],
      new Set(["/missing.png"]),
    );
    expect(r.get("broken-images")).toHaveLength(1);
    expect(r.get("broken-images")![0].observed).toMatchObject({ requestFailed: true });
    expect(r.get("missing-image-source")).toHaveLength(1);
    expect(r.get("distorted-images")).toHaveLength(1);
  });

  it("separates clipped controls from clipped text and ignores lazy images that have not loaded", () => {
    const clip = (control: boolean) => ({ selector: "x", text: "Subscribe", control, scrollWidth: 180, clientWidth: 60, scrollHeight: 20, clientHeight: 20, overflowX: "hidden", overflowY: "visible" });
    const r = analyzeLayout(measurement({ clipped: [clip(true), clip(false)], images: [{ selector: "img", src: "/l.png", hasSrc: true, complete: false, lazy: true, naturalWidth: 0, naturalHeight: 0, rect: rect(0, 0, 10, 10), objectFit: "fill", alt: null }] }), ["clipped-controls", "clipped-text", "broken-images"]);
    expect(r.get("clipped-controls")![0].message).toContain("cut off by 120px horizontally");
    expect(r.get("clipped-text")).toHaveLength(1);
    expect(r.get("broken-images")).toEqual([]);
  });

  it("runs mobile-only checks only on mobile viewports", () => {
    const small = { smallTargets: [{ selector: "a.icon", text: "", rect: rect(0, 0, 16, 16) }], visibleNavLinks: 0, menuToggleVisible: false };
    expect(analyzeLayout(measurement(small), ["touch-targets", "mobile-navigation"]).size).toBe(0);
    const mobile = analyzeLayout(measurement({ ...small, viewport: { width: 390, height: 844 } }), ["touch-targets", "mobile-navigation"]);
    expect(mobile.get("touch-targets")).toHaveLength(1);
    expect(mobile.get("mobile-navigation")![0].message).toBe("No navigation link or menu toggle is visible");
  });

  it("measures grid width consistency, alignment and spacing", () => {
    const items = [
      { selector: "a", text: "", rect: rect(0, 100, 300, 200) },
      { selector: "b", text: "", rect: rect(320, 106, 300, 200) },
      { selector: "c", text: "", rect: rect(660, 100, 200, 200) },
    ];
    const r = analyzeLayout(measurement({ groups: [{ container: ".grid", items }] }), ["grid-consistency", "alignment", "spacing"]);
    expect(r.get("grid-consistency")![0].message).toContain("200px to 300px");
    expect(r.get("alignment")![0].message).toBe("Top edges in one row differ by 6px");
    expect(r.get("spacing")![0].message).toBe("Gaps between items vary from 20px to 40px");
  });
});

// ---------------------------------------------------------------- typography

const sample = (role: TypographySample["role"], size: number, extra: Partial<TypographySample> = {}): TypographySample => ({
  role, tag: role.startsWith("h") ? role : "p", section: "Main", selector: role, text: "Text", fontFamily: "Inter, sans-serif", fontSizePx: size, fontWeight: "400",
  lineHeight: "1.5", letterSpacing: "normal", color: "rgb(0, 0, 0)", box: { w: 100, h: 20 }, ...extra,
});

describe("typography analysis", () => {
  it("flags small text, inconsistent heading styles and inverted heading sizes from measurements only", () => {
    const r = analyzeTypography([sample("h1", 32), sample("h2", 24), sample("h2", 20), sample("h3", 28), sample("paragraph", 10)]);
    expect(r.tooSmall.map((s) => s.fontSizePx)).toEqual([10]);
    expect(r.inconsistent[0]).toMatchObject({ tag: "h2" });
    expect(r.inversions[0]).toMatchObject({ higher: "h2", lower: "h3" });
    expect(analyzeTypography([sample("h1", 32), sample("h2", 24), sample("paragraph", 16)])).toEqual({ tooSmall: [], inconsistent: [], inversions: [] });
  });
});

// ---------------------------------------------------------------- SEO

const seo = (over: Partial<SeoSnapshot> = {}): SeoSnapshot => ({
  url: "https://shop.test/a", title: "Widgets for modern teams", metaDescription: "A".repeat(80), headings: [{ level: 1, text: "Widgets" }, { level: 2, text: "Specs" }],
  canonicals: ["https://shop.test/a"], robotsMeta: null, images: [{ src: "/a.png", alt: "A" }], og: { "og:title": "t", "og:description": "d", "og:image": "/i.png", "og:url": "u" }, twitter: { "twitter:card": "summary" },
  ...over,
});

describe("SEO extraction analysis", () => {
  const status = (s: SeoSnapshot, key: string) => analyzeSeo(s).find((f) => f.key === key)!.status;
  it("passes a well-formed page", () => {
    expect(analyzeSeo(seo()).every((f) => f.status === "PASS")).toBe(true);
  });
  it("detects missing title (FAIL) and best-practice gaps (WARNING)", () => {
    expect(status(seo({ title: null }), "title")).toBe("FAIL");
    expect(status(seo({ title: "Hi" }), "title")).toBe("WARNING");
    expect(status(seo({ metaDescription: null }), "meta-description")).toBe("WARNING");
    expect(status(seo({ headings: [] }), "h1")).toBe("WARNING");
    expect(status(seo({ headings: [{ level: 1, text: "a" }, { level: 3, text: "b" }] }), "heading-hierarchy")).toBe("WARNING");
    expect(status(seo({ canonicals: [] }), "canonical")).toBe("WARNING");
    expect(status(seo({ canonicals: ["https://other.test/"] }), "canonical")).toBe("WARNING");
    expect(status(seo({ robotsMeta: "noindex, nofollow" }), "robots-meta")).toBe("WARNING");
    expect(status(seo({ images: [{ src: "/x.png", alt: null }, { src: "/y.png", alt: "" }] }), "image-alt")).toBe("WARNING");
    expect(status(seo({ og: {} }), "open-graph")).toBe("WARNING");
    expect(status(seo({ twitter: {} }), "twitter")).toBe("WARNING");
  });
  it("finds duplicate titles and descriptions across pages", () => {
    const d = findDuplicates([
      { pageId: "1", url: "/a", title: "Same", description: "One" },
      { pageId: "2", url: "/b", title: "same ", description: "Two" },
      { pageId: "3", url: "/c", title: "Other", description: "Two" },
    ]);
    expect(d.titles[0].map((x) => x.pageId)).toEqual(["1", "2"]);
    expect(d.descriptions[0].map((x) => x.pageId)).toEqual(["2", "3"]);
  });
});

// ---------------------------------------------------------------- accessibility

describe("accessibility result mapping", () => {
  const rule = (id: string, nodes = 1) => ({ id, impact: "critical", description: `${id} desc`, help: `${id} help`, helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`, tags: ["wcag2a", "wcag111", "cat.text-alternatives"], nodes: Array.from({ length: nodes }, (_, i) => ({ target: [`img:nth-child(${i + 1})`], html: "<img src=x>", failureSummary: "Fix any of the following: add alt" })) });
  it("maps violations to FAIL, incomplete to WARNING, and never claims compliance", () => {
    const out = axeToOutcomes({ violations: [rule("image-alt", 2)], incomplete: [rule("color-contrast")], passes: [rule("document-title")], testEngine: { version: "4.13.0" } }, { browser: "chromium", viewport: "desktop-1440x900" });
    expect(out.map((o) => o.status)).toEqual(["FAIL", "WARNING", "PASS"]);
    expect(out[0].details).toHaveLength(2);
    expect(out[0].details![0]).toMatchObject({ table: "accessibility_results", values: { rule_id: "image-alt", impact: "critical", status: "FAIL", wcag_tags: '["wcag2a","wcag111"]' } });
    expect(out[0].actual).toContain(AUTOMATED_DISCLAIMER);
    expect(out[2].actual).toContain("does not establish WCAG compliance");
  });
});

// ---------------------------------------------------------------- console / network

describe("network analysis", () => {
  it("groups failed requests by resource type and party, and finds CORS messages", () => {
    const net = (url: string, resourceType: string, status: number | null, failure: string | null = null) => ({ url, method: "GET", resourceType, status, failure });
    const r = analyzeNetwork(
      "https://site.test/page",
      [net("https://site.test/app.js", "script", 404), net("https://site.test/style.css", "stylesheet", 200), net("https://cdn.other.test/font.woff2", "font", 500), net("https://site.test/aborted.png", "image", null, "net::ERR_ABORTED"), net("https://site.test/api", "fetch", 503)],
      [{ level: "error", message: "Access to fetch at 'https://api.other.test' has been blocked by CORS policy", sourceUrl: null }],
    );
    const g = (key: string) => r.groups.find((x) => x.key === key)!;
    expect(g("scripts").firstParty).toHaveLength(1);
    expect(g("stylesheets").firstParty).toHaveLength(0);
    expect(g("fonts").thirdParty).toHaveLength(1);
    expect(g("images").total).toBe(0);
    expect(g("other").firstParty).toHaveLength(1);
    expect(r.cors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- performance

const lhr = {
  lighthouseVersion: "13.5.0",
  categories: { performance: { score: 0.95 }, accessibility: { score: 0.7 }, "best-practices": { score: 1 }, seo: { score: 0.4 } },
  audits: {
    "largest-contentful-paint": { numericValue: 1800 },
    "cumulative-layout-shift": { numericValue: 0.3 },
    "first-contentful-paint": { numericValue: 900 },
    "total-blocking-time": { numericValue: 350 },
    "speed-index": { numericValue: 1200 },
    "server-response-time": { numericValue: 40 },
    "total-byte-weight": { numericValue: 50000 },
  },
};

describe("performance result handling", () => {
  it("maps a Lighthouse result without inventing missing metrics", () => {
    const m = measurementFromLhr(lhr, "https://site.test/", "desktop");
    expect(m).toMatchObject({ source: "LOCAL_LIGHTHOUSE", toolVersion: "Lighthouse 13.5.0", scores: { performance: 0.95, seo: 0.4 }, lcpMs: 1800, cls: 0.3, inpMs: null, requestCount: null });
  });

  it("rates values with published thresholds", () => {
    expect(rateMetric("lcpMs", 2500)).toBe("good");
    expect(rateMetric("lcpMs", 3000)).toBe("needs-improvement");
    expect(rateMetric("cls", 0.3)).toBe("poor");
    expect(ratingToStatus(rateScore(0.89))).toBe("WARNING");
    expect(ratingToStatus(rateScore(0.49))).toBe("FAIL");
  });

  it("builds outcomes: scores and metrics rated, INP not executed, row labelled as local Lighthouse", () => {
    const out = performanceOutcomes(measurementFromLhr(lhr, "https://site.test/", "desktop"), { browser: "chromium", viewport: "desktop-1440x900" });
    const byTitle = (t: string) => out.find((o) => o.spec.title.startsWith(t))!;
    expect(byTitle("Lighthouse Performance score").status).toBe("PASS");
    expect(byTitle("Lighthouse Accessibility score").status).toBe("WARNING");
    expect(byTitle("Lighthouse SEO score").status).toBe("FAIL");
    expect(byTitle("Cumulative Layout Shift").status).toBe("FAIL");
    expect(byTitle("Total Blocking Time").status).toBe("WARNING");
    expect(byTitle("Interaction to Next Paint").status).toBe("NOT EXECUTED");
    expect(out[0].details![0]).toMatchObject({ table: "performance_results", values: { source: "LOCAL_LIGHTHOUSE", performance_score: 0.95, inp_ms: null, form_factor: "desktop" } });
    expect(out.every((o) => o.status !== "FAIL" || o.evidence.length > 0)).toBe(true);
  });

  it("reports scores as NOT EXECUTED for the browser-timing fallback", () => {
    const fallback: PerformanceMeasurement = { ...measurementFromLhr(lhr, "https://site.test/", "mobile"), source: "LOCAL_BROWSER", scores: { performance: null, accessibility: null, bestPractices: null, seo: null }, tbtMs: null, speedIndexMs: null };
    const out = performanceOutcomes(fallback, { browser: "firefox", viewport: "mobile-390x844" });
    expect(out.filter((o) => o.spec.title.includes("score")).every((o) => o.status === "NOT EXECUTED")).toBe(true);
    expect(out.find((o) => o.spec.title.startsWith("Largest Contentful Paint"))!.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------- ecommerce

describe("ecommerce detection", () => {
  const signals = (over: Partial<EcomSignals>): EcomSignals => ({ productLinks: [], addToCart: null, variants: [], quantity: null, cartCountText: null, cartLink: null, checkout: null, cartQuantity: null, updateButton: null, removeControl: null, emptyCartText: false, heading: "", ...over });
  it("recognises listings, product pages and carts", () => {
    expect(hasEcommerce(signals({}))).toBe(false);
    expect(hasEcommerce(signals({ productLinks: [{ qid: "a", href: "/p/1", text: "A" }, { qid: "b", href: "/p/2", text: "B" }] }))).toBe(true);
    expect(hasEcommerce(signals({ addToCart: { qid: "x", text: "Add to cart", formMethod: "post" } }))).toBe(true);
    expect(hasEcommerce(signals({ checkout: { qid: "c", text: "Checkout", tag: "a", href: "/checkout" } }))).toBe(true);
  });
  it("never treats purchase controls as safe", () => {
    for (const t of ["Place order", "Pay now", "Buy now", "Complete purchase", "Confirm payment"]) expect(PURCHASE_ACTION.test(t), t).toBe(true);
    for (const t of ["Add to cart", "Proceed to checkout", "Update cart"]) expect(PURCHASE_ACTION.test(t), t).toBe(false);
  });
});

// ---------------------------------------------------------------- Figma, expectations, options, persistence

describe("Figma architecture", () => {
  const ctx = (figmaUrl: string | null) => ({ project: { websiteUrl: "https://x.test/", testEmail: null, figmaUrl } }) as never;
  it("is NOT EXECUTED without a Figma URL or without design data", async () => {
    expect((await createFigmaModule(new NotConfiguredFigmaProvider()).run(ctx(null)))[0]).toMatchObject({ status: "NOT EXECUTED", actual: expect.stringContaining("no Figma URL") });
    expect((await createFigmaModule(new NotConfiguredFigmaProvider()).run(ctx("https://www.figma.com/design/AbC/x")))[0].actual).toMatch(/FIGMA_ACCESS_TOKEN/);
    expect((await createFigmaModule(new RestFigmaProvider("token")).run(ctx("https://www.figma.com/design/AbC/x")))[0].actual).toMatch(/not implemented/);
  });
});

describe("expectation hierarchy", () => {
  const spec: CaseSpec = { key: "k", module: "ui", title: "t", section: "s", scenarioType: "FUNCTIONAL", feature: "f", element: "e", steps: [], expected: "x" };
  it("never lets an AI exploratory expectation produce a verified failure", () => {
    const r = finalizeOutcome(outcome.fail({ ...spec, expectationSource: "AI_EXPLORATORY" }, "differs", [{ type: "note", label: "n", content: "c" }]));
    expect(r.status).toBe("WARNING");
    expect(r.adjustment).toMatch(/AI exploration/);
    expect(finalizeOutcome(outcome.fail({ ...spec, expectationSource: "REFERENCE_DOCUMENT" }, "differs", [{ type: "note", label: "n", content: "c" }])).status).toBe("FAIL");
  });

  it("applies Phase 3 option defaults to older runs", () => {
    expect(resolveRunOptions({ allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 })).toMatchObject({ typographyMode: "TYPOGRAPHY_TAGS", content: { mode: "SECTION" }, performance: { formFactors: ["desktop"] } });
  });
});

describe("detail persistence", () => {
  let db: LocalDatabaseProvider;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(async () => db.close());

  it("stores whitelisted measurement rows linked to the result and the case's expectation source", async () => {
    const project = await db.projects.create(projectInput({ websiteUrl: "https://site.test/" }));
    const { page } = await db.pages.addManual(project.id, "https://site.test/", "https://site.test/");
    const run = await db.testRuns.createAndEnqueue({ projectId: project.id, configurationId: null, name: null, modules: ["seo"], browsers: ["chromium"], viewports: ["desktop-1366x768"], pageIds: [page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 } });
    const store = new SqliteEngineStore(db.sqlite);
    const rp = store.ensureRunPage(run.id, page.id);
    const spec: CaseSpec = { key: "seo:title", module: "seo", title: "Title", section: "SEO", scenarioType: "FUNCTIONAL", feature: "SEO", element: "title", steps: [], expected: "x", expectationSource: "BROWSER_STANDARD" };
    const row = detail("seo_results", { check_key: "title", status: "PASS", observed_value: "Home", message: "ok", expected: "10–60" });
    (row.values as Record<string, unknown>)["id); DROP TABLE projects; --"] = "evil";
    const resultId = store.recordOutcome({ runId: run.id, projectId: project.id, pageId: page.id, pageUrl: page.url, runPageId: rp, browser: "chromium", viewport: "desktop-1366x768", outcome: finalizeOutcome(outcome.pass(spec, "ok", ["v"], { details: [row] })) });
    const stored = db.sqlite.prepare("SELECT * FROM seo_results WHERE test_result_id = ?").all(resultId) as Record<string, unknown>[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ check_key: "title", status: "PASS", observed_value: "Home", page_id: page.id, test_run_id: run.id });
    expect(await db.projects.count()).toBe(1);
    expect((await db.testResults.listByRun(run.id))[0].expectationSource).toBe("BROWSER_STANDARD");
  });
});
