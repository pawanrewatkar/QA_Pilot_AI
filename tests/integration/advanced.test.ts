import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeCrawlUrl } from "@/lib/crawler/normalize";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import type { TestResultRecord } from "@/types";
import { executeRun } from "@/worker/test-engine/run-executor";
import { ABOUT_REFERENCE_MD, startFixtureSite, type FixtureSite } from "../fixtures/site-server";
import { createTestDb, makeTempDir, projectInput } from "../helpers";
import { browserInstalled, INTEGRATION_TIMEOUT } from "./helpers";

const MODULES = ["ui", "responsive", "typography", "accessibility", "seo", "performance", "content", "ecommerce", "console", "network", "forms", "figma"];
const PATHS = ["/ui-issues", "/about-company", "/shop", "/contact"];

describe.skipIf(!browserInstalled("chromium"))("advanced modules against a real site (Chromium)", () => {
  let site: FixtureSite;
  let db: LocalDatabaseProvider;
  let root: string;
  let runId = "";
  let results: TestResultRecord[] = [];
  let summary: Awaited<ReturnType<typeof executeRun>>;
  const rows = (table: string, where = "1=1", ...params: unknown[]) => db.sqlite.prepare(`SELECT * FROM ${table} WHERE test_run_id = ? AND ${where}`).all(runId, ...params) as Record<string, unknown>[];
  const at = (path: string) => (r: TestResultRecord) => r.url === `${site.origin}${path}`;
  const find = (pred: (r: TestResultRecord) => boolean) => results.filter(pred);
  const one = (pred: (r: TestResultRecord) => boolean, label: string) => {
    const hits = find(pred);
    expect(hits.length, label).toBeGreaterThan(0);
    return hits[0];
  };

  beforeAll(async () => {
    site = await startFixtureSite();
    db = createTestDb();
    root = makeTempDir();
    const storage = new LocalStorageProvider(root);
    const project = await db.projects.create(projectInput({ websiteUrl: `${site.origin}/`, testEmail: "qa@example.com" }));
    const key = `projects/${project.id}/documents/reference.md`;
    await storage.put(key, new TextEncoder().encode(ABOUT_REFERENCE_MD));
    await db.documents.create({ projectId: project.id, kind: "REFERENCE", fileName: "about.md", mimeType: "text/markdown", sizeBytes: ABOUT_REFERENCE_MD.length, storageKey: key, checksumSha256: "x" });
    const pageIds: string[] = [];
    for (const path of PATHS) pageIds.push((await db.pages.addManual(project.id, `${site.origin}${path}`, normalizeCrawlUrl(`${site.origin}${path}`)!)).page.id);
    const run = await db.testRuns.createAndEnqueue({
      projectId: project.id, configurationId: null, name: "Phase 3", modules: MODULES, browsers: ["chromium"], viewports: ["desktop-1440x900"], pageIds, configurationName: null,
      options: { allowFormSubmission: false, maxLinksPerPage: 50, navigationTimeoutMs: 20_000, typographyMode: "TYPOGRAPHY_CONTENT", content: { mode: "SECTION", exclusions: ["header", "footer", "navigation"], customSelectors: [] }, performance: { formFactors: ["desktop"] } },
    });
    runId = run.id;
    summary = await executeRun(run.id, { store: new SqliteEngineStore(db.sqlite), storage, log: () => undefined });
    results = await db.testResults.listByRun(run.id, { limit: 2000 });
  }, INTEGRATION_TIMEOUT * 3);

  afterAll(async () => {
    await site?.close();
    await db?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("completes and keeps the result-integrity rules", () => {
    expect(summary.status).toBe("COMPLETED");
    for (const r of results) {
      if (r.status === "PASS") expect(r.verifications.length, r.title).toBeGreaterThan(0);
      if (r.status === "FAIL") expect(r.evidence.length, r.title).toBeGreaterThan(0);
      if (["NOT EXECUTED", "NOT APPLICABLE"].includes(r.status)) expect(r.executedAt).toBeNull();
    }
  });

  it("UI testing measures real layout defects", () => {
    const ui = (check: string) => one((r) => r.module === "ui" && at("/ui-issues")(r) && r.title === check, check);
    expect(ui("No unexpected horizontal scrolling").status).toBe("FAIL");
    expect(ui("Images load").status).toBe("FAIL");
    expect(ui("Images keep their aspect ratio").status).toBe("WARNING");
    expect(ui("Button and CTA labels are fully visible").status).toBe("FAIL");
    expect(ui("Interactive elements are not covered").status).toBe("WARNING");
    expect(one((r) => r.module === "ui" && at("/about-company")(r) && r.title === "No unexpected horizontal scrolling", "clean page").status).toBe("PASS");
    const uiRows = rows("ui_results", "category = 'UI' AND status = 'FAIL'");
    expect(uiRows.some((r) => r.check_key === "horizontal-overflow" && String(r.observed).includes("scrollWidth"))).toBe(true);
  });

  it("responsive testing runs all six viewports and reports where problems occur", () => {
    const vps = new Set(find((r) => r.module === "responsive").map((r) => r.viewport));
    expect([...vps].sort()).toEqual(["desktop-1366x768", "desktop-1440x900", "desktop-1920x1080", "mobile-375x812", "mobile-390x844", "mobile-412x915"]);
    expect(find((r) => r.module === "responsive" && r.title.startsWith("Touch targets")).every((r) => r.viewport?.startsWith("mobile"))).toBe(true);
    expect(one((r) => r.module === "responsive" && at("/ui-issues")(r) && r.title === "No unexpected horizontal scrolling at 390×844", "mobile overflow").status).toBe("FAIL");
    expect(find((r) => r.module === "responsive" && r.status === "FAIL").some((r) => r.evidence.some((e) => e.type === "screenshot"))).toBe(true);
  });

  it("typography is measured without inventing expected values", () => {
    expect(one((r) => r.module === "typography" && r.title === "Typography matches the design reference", "reference").status).toBe("NOT EXECUTED");
    const t = rows("typography_results");
    expect(t.length).toBeGreaterThan(5);
    expect(t.every((r) => r.expected === null && r.difference === null && r.status === "NOT EXECUTED")).toBe(true);
    expect(t.some((r) => r.role === "h1" && Number(r.font_size_px) > 0 && r.tag === "h1" && typeof r.text_content === "string")).toBe(true);
  });

  it("accessibility uses axe-core and stores rule-level evidence", () => {
    const alt = one((r) => r.module === "accessibility" && at("/ui-issues")(r) && r.feature === "image-alt", "image-alt");
    expect(alt.status).toBe("FAIL");
    expect(alt.actualResult).toContain("does not establish WCAG compliance");
    expect(rows("accessibility_results", "rule_id = 'image-alt' AND status = 'FAIL'").length).toBeGreaterThan(0);
    expect(find((r) => r.module === "accessibility" && r.feature === "Keyboard").length).toBeGreaterThan(0);
  });

  it("SEO findings are evidence-based and stored", () => {
    expect(one((r) => r.module === "seo" && r.title === "Page has a title" && at("/shop")(r), "title").status).toBe("PASS");
    expect(one((r) => r.module === "seo" && r.title === "Page has no broken links" && at("/shop")(r), "broken links").status).toBe("FAIL");
    expect(one((r) => r.module === "seo" && r.title === "Open Graph metadata is present", "og").status).toBe("WARNING");
    expect(find((r) => r.module === "seo" && r.title.startsWith("Title is unique")).length).toBe(PATHS.length);
    expect(rows("seo_results").length).toBeGreaterThan(20);
  });

  it("performance comes from local Lighthouse, never a fabricated score", () => {
    const perf = rows("performance_results");
    expect(perf.length).toBe(PATHS.length);
    for (const p of perf) {
      expect(["LOCAL_LIGHTHOUSE", "LOCAL_BROWSER"]).toContain(p.source);
      if (p.source === "LOCAL_LIGHTHOUSE") {
        expect(Number(p.performance_score)).toBeGreaterThanOrEqual(0);
        expect(Number(p.performance_score)).toBeLessThanOrEqual(1);
        expect(String(p.tool_version)).toMatch(/^Lighthouse \d+/);
      } else expect(p.performance_score).toBeNull();
    }
    expect(one((r) => r.module === "performance" && r.title.startsWith("Interaction to Next Paint"), "INP").status).toBe("NOT EXECUTED");
  });

  it("content comparison reports differences against the reference document", () => {
    const c = (title: string) => one((r) => r.module === "content" && at("/about-company")(r) && r.title.startsWith(title), title);
    expect(c("Reference content is present").status).toBe("FAIL");
    expect(c("Page spelling matches the reference").status).toBe("FAIL");
    expect(c("No unintentionally repeated content").status).toBe("WARNING");
    expect(c("Call-to-action labels match the reference").status).toBe("WARNING");
    expect(c("Reference content is present").title).toContain("Section comparison");
    expect(c("Reference content is present").expectationSource).toBe("REFERENCE_DOCUMENT");
    expect(one((r) => r.module === "content" && at("/shop")(r), "shop").status).toBe("NOT APPLICABLE");
    const cc = rows("content_comparisons", "kind = 'SPELLING'");
    expect(cc[0]).toMatchObject({ mode: "SECTION", expected_text: "The company was founded in 2015 by two engineers in Berlin." });
  });

  it("ecommerce walks the cart flow and stops before payment", () => {
    const e = (title: string) => one((r) => r.module === "ecommerce" && at("/shop")(r) && r.title.startsWith(title), title).status;
    expect(e("Product listing opens a product detail page")).toBe("PASS");
    expect(e('Variant "Size" can be selected')).toBe("PASS");
    expect(e("Quantity can be changed")).toBe("PASS");
    expect(e("Add to cart updates the cart")).toBe("PASS");
    expect(e("Cart shows the added product")).toBe("PASS");
    expect(e("Cart quantity can be updated")).toBe("PASS");
    expect(e("Checkout can be reached")).toBe("PASS");
    expect(e("Item can be removed from the cart")).toBe("PASS");
    expect(site.writes.some((w) => w.url === "/cart/add")).toBe(true);
    expect(site.writes.some((w) => w.url.startsWith("/checkout"))).toBe(false);
  });

  it("forms: labels verified and duplicate submission assessed with nothing sent", () => {
    expect(one((r) => r.module === "forms" && r.title.includes("every field has a label"), "labels").status).toBe("PASS");
    // The verdict reflects what the browser actually attempted; either way the evidence lists intercepted requests only.
    const dup = one((r) => r.module === "forms" && r.title.includes("duplicate submission"), "duplicate");
    expect(["PASS", "WARNING"]).toContain(dup.status);
    expect(dup.evidence[0].content).toMatch(/aborted, nothing sent/);
    expect(site.writes.some((w) => w.url === "/contact")).toBe(false);
  });

  it("console and network capture failures with browser and viewport", () => {
    expect(one((r) => r.module === "network" && at("/ui-issues")(r) && r.title === "JavaScript files load successfully", "js").status).toBe("FAIL");
    expect(one((r) => r.module === "network" && at("/ui-issues")(r) && r.title === "Images load successfully", "img").status).toBe("FAIL");
    const net = rows("network_results", "status_code = 404");
    expect(net.some((n) => n.browser === "chromium" && n.viewport === "desktop-1440x900" && String(n.url).endsWith("/missing.js") && n.error_category === "NOT_FOUND")).toBe(true);
  });

  it("Figma comparison is NOT EXECUTED without design data", () => {
    expect(find((r) => r.module === "figma").every((r) => r.status === "NOT EXECUTED")).toBe(true);
  });
});
