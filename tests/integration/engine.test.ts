import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeCrawlUrl } from "@/lib/crawler/normalize";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import type { TestResultRecord } from "@/types";
import { executeRun } from "@/worker/test-engine/run-executor";
import { startFixtureSite, type FixtureSite } from "../fixtures/site-server";
import { createTestDb, makeTempDir, projectInput } from "../helpers";
import { browserInstalled, INTEGRATION_TIMEOUT } from "./helpers";

const MODULES = ["links", "navigation", "functional", "tabs", "accordion", "modals", "carousel", "dropdowns", "downloads", "search", "forms", "login", "console", "network", "breadcrumb", "pagination", "seo"];

describe.skipIf(!browserInstalled("chromium"))("test engine against a real site (Chromium)", () => {
  let site: FixtureSite;
  let db: LocalDatabaseProvider;
  let root: string;
  let results: TestResultRecord[] = [];
  let runId = "";
  let summary: Awaited<ReturnType<typeof executeRun>>;

  const find = (pred: (r: TestResultRecord) => boolean) => results.filter(pred);
  const one = (pred: (r: TestResultRecord) => boolean, label: string) => {
    const hits = find(pred);
    expect(hits.length, `${label}: ${hits.length} matching results`).toBeGreaterThan(0);
    return hits[0];
  };

  beforeAll(async () => {
    site = await startFixtureSite();
    db = createTestDb();
    root = makeTempDir();
    const project = await db.projects.create(projectInput({ websiteUrl: `${site.origin}/`, testEmail: "qa@example.com" }));
    const pageIds: string[] = [];
    for (const path of ["/", "/contact", "/broken-tabs", "/blog", "/blog/post-1", "/login", "/invalid-pattern"]) {
      const url = `${site.origin}${path}`;
      pageIds.push((await db.pages.addManual(project.id, url, normalizeCrawlUrl(url)!)).page.id);
    }
    const run = await db.testRuns.createAndEnqueue({
      projectId: project.id,
      configurationId: null,
      name: "Integration",
      modules: MODULES,
      browsers: ["chromium"],
      viewports: ["desktop-1440x900", "mobile-390x844"],
      pageIds,
      configurationName: null,
      options: { allowFormSubmission: false, maxLinksPerPage: 100, navigationTimeoutMs: 15_000 },
    });
    runId = run.id;
    summary = await executeRun(run.id, { store: new SqliteEngineStore(db.sqlite), storage: new LocalStorageProvider(root), log: () => undefined });
    results = await db.testResults.listByRun(run.id, { limit: 2000 });
  }, INTEGRATION_TIMEOUT * 2);

  afterAll(async () => {
    await site?.close();
    await db?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("completes the run and reports progress", async () => {
    expect(summary.status).toBe("COMPLETED");
    const detail = await db.testRuns.getDetail(runId);
    expect(detail).toMatchObject({ status: "COMPLETED", progressTotal: 14, progressCompleted: 14 });
    expect(detail!.counts.PASS).toBeGreaterThan(20);
  });

  it("never sends a form submission or any other write to the website", () => {
    expect(site.writes).toEqual([]);
  });

  it("enforces result integrity: every verdict is executed, PASS is verified, FAIL has evidence", () => {
    for (const r of results) {
      if (["PASS", "FAIL", "WARNING"].includes(r.status)) expect(r.executedAt, r.title).not.toBeNull();
      else expect(r.executedAt, r.title).toBeNull();
      if (r.status === "PASS") expect(r.verifications.length, r.title).toBeGreaterThan(0);
      if (r.status === "FAIL") expect(r.evidence.length, r.title).toBeGreaterThan(0);
    }
  });

  it("classifies links: 404 and reproduced 500 fail, valid links and schemes pass", () => {
    expect(one((r) => r.module === "links" && r.element!.includes("/missing-page"), "404 link").status).toBe("FAIL");
    expect(one((r) => r.module === "links" && r.element!.includes("/server-error"), "500 link").status).toBe("FAIL");
    expect(one((r) => r.module === "links" && r.element!.endsWith(`${site.origin}/about`), "about link").status).toBe("PASS");
    expect(one((r) => r.module === "links" && r.element!.includes("mailto:hello@example.com"), "valid mailto").status).toBe("PASS");
    expect(one((r) => r.module === "links" && r.element!.includes("mailto:not-an-email"), "invalid mailto").status).toBe("FAIL");
    expect(one((r) => r.module === "links" && r.element!.includes("tel:+15550100"), "tel").status).toBe("PASS");
    expect(one((r) => r.module === "links" && r.feature === "External link", "external link").status).toBe("PASS");
  });

  it("verifies interactive components by state change, and fails a broken one", () => {
    const tabsHome = one((r) => r.module === "tabs" && r.url === `${site.origin}/` && r.title.includes("Pro"), "home tabs");
    expect(tabsHome.status).toBe("PASS");
    expect(tabsHome.verifications.join(" ")).toContain('aria-selected="true"');
    expect(one((r) => r.module === "tabs" && r.url === `${site.origin}/broken-tabs` && r.title.includes("panel"), "broken tabs").status).toBe("FAIL");
    expect(one((r) => r.module === "tabs" && r.title.includes("Arrow keys") && r.url === `${site.origin}/`, "tab keyboard").status).toBe("PASS");
    expect(one((r) => r.module === "accordion" && r.url === `${site.origin}/`, "details").status).toBe("PASS");
    expect(one((r) => r.module === "modals" && r.title.startsWith("Modal opens"), "modal open").status).toBe("PASS");
    expect(one((r) => r.module === "modals" && r.title.startsWith("Modal can be closed"), "modal close").status).toBe("PASS");
    expect(one((r) => r.module === "carousel", "carousel").status).toBe("PASS");
    expect(one((r) => r.module === "dropdowns" && r.feature === "Dropdown (select)", "select").status).toBe("PASS");
  });

  it("tests navigation, including the hamburger menu on mobile only", () => {
    const toggles = find((r) => r.module === "navigation" && r.feature === "Hamburger menu");
    expect(toggles.length).toBeGreaterThan(0);
    expect(toggles.every((r) => r.viewport === "mobile-390x844")).toBe(true);
    expect(toggles.every((r) => r.status === "PASS")).toBe(true);
    expect(one((r) => r.module === "navigation" && r.feature === "Navigation link" && r.element!.includes("/about") && r.viewport === "desktop-1440x900", "nav link").status).toBe("PASS");
    expect(find((r) => !!r.element?.includes("/logout") && r.module === "navigation")).toHaveLength(0);
  });

  it("verifies downloads, search, pagination and breadcrumbs", () => {
    expect(one((r) => r.module === "downloads", "download").status).toBe("PASS");
    expect(one((r) => r.module === "search" && r.scenarioType === "POSITIVE" && r.url === `${site.origin}/`, "valid search").status).toBe("PASS");
    expect(one((r) => r.module === "search" && r.scenarioType === "BOUNDARY" && r.url === `${site.origin}/`, "search maxlength").status).toBe("PASS");
    expect(one((r) => r.module === "search" && r.scenarioType === "NEGATIVE" && r.url === `${site.origin}/`, "special chars").status).toBe("PASS");
    expect(one((r) => r.module === "pagination" && r.url === `${site.origin}/blog`, "pagination").status).toBe("PASS");
    expect(one((r) => r.module === "breadcrumb" && r.title.includes("current page"), "breadcrumb current").status).toBe("PASS");
  });

  it("tests forms safely with negative, edge and boundary scenarios", () => {
    const contact = (pred: (r: TestResultRecord) => boolean) => find((r) => r.module === "forms" && r.url === `${site.origin}/contact` && pred(r));
    expect(contact((r) => r.title.includes("empty required"))[0].status).toBe("PASS");
    expect(contact((r) => r.title.includes("invalid email"))[0].status).toBe("PASS");
    expect(contact((r) => r.title.includes("invalid phone"))[0].status).toBe("PASS");
    expect(contact((r) => r.title.includes("valid data passes"))[0].status).toBe("PASS");
    expect(contact((r) => r.scenarioType === "BOUNDARY" && r.title.includes("maximum length 500"))[0].status).toBe("PASS");
    expect(contact((r) => r.title.includes("special characters"))[0].status).toBe("PASS");
    const real = contact((r) => r.title.includes("valid submission succeeds"))[0];
    expect(real.status).toBe("NOT EXECUTED");
    expect(real.actualResult).toMatch(/disabled/);
    const duplicate = contact((r) => r.title.includes("duplicate"))[0];
    expect(["PASS", "WARNING"]).toContain(duplicate.status); // measured with every request intercepted (Phase 3)
    expect(duplicate.evidence[0].content).toMatch(/aborted, nothing sent/);
    const broken = find((r) => r.module === "forms" && r.url === `${site.origin}/invalid-pattern` && r.title.includes("invalid phone"))[0];
    expect(broken.status).toBe("FAIL");
    expect(broken.actualResult).toMatch(/not a valid regular expression/);
  });

  it("refuses to fake login results without credentials", () => {
    expect(one((r) => r.module === "login" && r.title.includes("empty required"), "login empty").status).toBe("PASS");
    expect(one((r) => r.module === "login" && r.title.includes("valid credentials sign in"), "valid login").status).toBe("NOT EXECUTED");
    expect(one((r) => r.module === "login" && r.title.includes("invalid credentials"), "invalid login").status).toBe("NOT EXECUTED");
  });

  it("reports console/network findings and runs SEO", () => {
    expect(one((r) => r.module === "console" && r.feature === "JavaScript errors", "console").status).toBe("PASS");
    expect(one((r) => r.module === "seo" && r.title === "Page has a title", "seo").status).toBe("PASS");
    expect(one((r) => r.module === "page-load", "page load").status).toBe("PASS");
  });

  it("stores screenshot evidence that can be served", async () => {
    const shots = results.flatMap((r) => r.evidence).filter((e) => e.type === "screenshot");
    expect(shots.length).toBeGreaterThan(0);
    expect(await db.testResults.isKnownArtifact(shots[0].storageKey!)).toBe(true);
    expect(fs.existsSync(`${root}/${shots[0].storageKey}`)).toBe(true);
  });

  it("creates browser-independent test cases with stable codes", async () => {
    const cases = await db.testCases.list({ testRunId: runId, limit: 5000 });
    expect(cases.length).toBeGreaterThan(30);
    expect(new Set(cases.map((c) => c.code)).size).toBe(cases.length);
    const tabCase = cases.find((c) => c.module === "tabs" && c.pageUrl === `${site.origin}/` && c.title.includes("Pro"));
    expect(tabCase?.resultSummary.reduce((n, s) => n + s.count, 0)).toBe(2); // desktop + mobile
  });
});

describe("cross-browser execution", () => {
  for (const browser of ["firefox", "webkit"] as const) {
    it.skipIf(!browserInstalled(browser))(`${browser}: loads a page and verifies a component`, async () => {
      const site = await startFixtureSite();
      const db = createTestDb();
      const root = makeTempDir();
      try {
        const project = await db.projects.create(projectInput({ websiteUrl: `${site.origin}/` }));
        const { page } = await db.pages.addManual(project.id, `${site.origin}/`, normalizeCrawlUrl(`${site.origin}/`)!);
        const run = await db.testRuns.createAndEnqueue({
          projectId: project.id, configurationId: null, name: browser, modules: ["tabs", "accordion"], browsers: [browser], viewports: ["desktop-1366x768"],
          pageIds: [page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 20, navigationTimeoutMs: 20_000 },
        });
        const summary = await executeRun(run.id, { store: new SqliteEngineStore(db.sqlite), storage: new LocalStorageProvider(root), log: () => undefined });
        const results = await db.testResults.listByRun(run.id);
        expect(summary.status).toBe("COMPLETED");
        expect(results.find((r) => r.module === "page-load")?.status).toBe("PASS");
        expect(results.find((r) => r.module === "tabs" && r.title.includes("Pro"))?.status).toBe("PASS");
        expect(results.find((r) => r.module === "accordion")?.status).toBe("PASS");
        expect(results.every((r) => r.browser === browser)).toBe(true);
      } finally {
        await site.close();
        await db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, INTEGRATION_TIMEOUT);
  }

  it("records NOT EXECUTED (never PASS) when a browser cannot start", async () => {
    const db = createTestDb();
    const root = makeTempDir();
    try {
      const project = await db.projects.create(projectInput());
      const { page } = await db.pages.addManual(project.id, "https://example.com/", "https://example.com/");
      const run = await db.testRuns.createAndEnqueue({
        projectId: project.id, configurationId: null, name: "x", modules: ["tabs"], browsers: ["chromium"], viewports: ["desktop-1366x768"],
        pageIds: [page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 20, navigationTimeoutMs: 5_000 },
      });
      const summary = await executeRun(run.id, {
        store: new SqliteEngineStore(db.sqlite), storage: new LocalStorageProvider(root), log: () => undefined,
        launch: async () => { throw new Error("Executable doesn't exist"); },
      });
      const results = await db.testResults.listByRun(run.id);
      expect(summary.status).toBe("COMPLETED");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.status === "NOT EXECUTED" && r.executedAt === null)).toBe(true);
    } finally {
      await db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
