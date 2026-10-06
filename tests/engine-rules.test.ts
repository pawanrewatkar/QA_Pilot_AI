import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPLEMENTED_MODULE_IDS } from "@/lib/constants/testing";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import type { FormField } from "@/lib/forms/analyze";
import { safeValueFor } from "@/lib/forms/test-data";
import type { HttpResult } from "@/lib/net/http";
import { classifyBrowserError } from "@/lib/playwright/errors";
import { addManualPages, createTestRun, startCrawl } from "@/lib/services/engine";
import { classifyLinkKind, classifyLinkResponse, LinkChecker, validateMailto, validateTel } from "@/lib/testing/link-check";
import { finalizeOutcome, outcome, type CaseSpec } from "@/lib/testing/outcome";
import { IMPLEMENTED_MODULE_IDS as ENGINE_IDS, planExecution, SCENARIO_MODULES } from "@/lib/testing/registry";
import { parseCrawlConfig } from "@/lib/validation/crawl";
import { parseTestRunForm } from "@/lib/validation/test-run";
import { createTestDb, projectInput } from "./helpers";

const spec: CaseSpec = { key: "k", module: "tabs", title: "t", section: "s", scenarioType: "FUNCTIONAL", feature: "f", element: "e", steps: [], expected: "x" };

describe("result status rules", () => {
  const fixed = () => new Date("2026-01-01T00:00:00.000Z");

  it("keeps a verified PASS and stamps execution time", () => {
    const r = finalizeOutcome(outcome.pass(spec, "ok", ["aria-selected true"]), fixed);
    expect(r).toMatchObject({ status: "PASS", executedAt: "2026-01-01T00:00:00.000Z", adjustment: null });
  });

  it("downgrades an unverified PASS to WARNING", () => {
    const r = finalizeOutcome(outcome.pass(spec, "clicked", []), fixed);
    expect(r.status).toBe("WARNING");
    expect(r.adjustment).toMatch(/no recorded verification/);
  });

  it("downgrades a FAIL without evidence to WARNING", () => {
    const r = finalizeOutcome(outcome.fail(spec, "broken", []), fixed);
    expect(r.status).toBe("WARNING");
    expect(r.adjustment).toMatch(/no captured evidence/);
  });

  it("never stamps NOT EXECUTED or NOT APPLICABLE as executed", () => {
    expect(finalizeOutcome(outcome.notExecuted(spec, "no browser"), fixed).executedAt).toBeNull();
    expect(finalizeOutcome(outcome.notApplicable(spec, "no tabs"), fixed).executedAt).toBeNull();
  });
});

const res = (over: Partial<HttpResult>): HttpResult => ({ ok: false, status: null, finalUrl: "https://x.test/", chain: [], contentType: null, contentLength: null, durationMs: 1, ...over });

describe("link verdicts", () => {
  it.each([
    [res({ ok: true, status: 200 }), undefined, "PASS"],
    [res({ ok: true, status: 200, chain: [{ url: "a", status: 301 }] }), undefined, "PASS"],
    [res({ status: 404 }), undefined, "FAIL"],
    [res({ status: 410 }), undefined, "FAIL"],
    [res({ status: 503 }), res({ status: 503 }), "FAIL"],
    [res({ status: 503 }), res({ ok: true, status: 200 }), "WARNING"],
    [res({ status: 403 }), undefined, "WARNING"],
    [res({ status: 429 }), undefined, "WARNING"],
    [res({ status: 999 }), undefined, "WARNING"],
    [res({ status: 418 }), undefined, "WARNING"],
    [res({ error: { kind: "DNS", message: "ENOTFOUND" } }), undefined, "FAIL"],
    [res({ error: { kind: "TIMEOUT", message: "t" } }), undefined, "WARNING"],
    [res({ error: { kind: "SSL", message: "cert" } }), undefined, "WARNING"],
    [res({ error: { kind: "REDIRECT_LOOP", message: "loop" } }), undefined, "FAIL"],
  ])("%#", (first, retry, expected) => {
    expect(classifyLinkResponse(first, retry).status).toBe(expected);
  });

  it("classifies link kinds", () => {
    const page = "https://site.test/a";
    expect(classifyLinkKind("/b", "https://site.test/b", page, false)).toBe("internal");
    expect(classifyLinkKind("https://www.site.test/b", "https://www.site.test/b", page, false)).toBe("internal");
    expect(classifyLinkKind("https://other.test/", "https://other.test/", page, false)).toBe("external");
    expect(classifyLinkKind("https://www.linkedin.com/company/x", "https://www.linkedin.com/company/x", page, false)).toBe("social");
    expect(classifyLinkKind("/guide.pdf", "https://site.test/guide.pdf", page, false)).toBe("download");
    expect(classifyLinkKind("/x", "https://site.test/x", page, true)).toBe("download");
    expect(classifyLinkKind("mailto:a@b.co", "mailto:a@b.co", page, false)).toBe("mailto");
    expect(classifyLinkKind("#top", "https://site.test/a#top", page, false)).toBe("anchor");
    expect(classifyLinkKind("javascript:void(0)", "javascript:void(0)", page, false)).toBe("javascript");
    expect(classifyLinkKind("", "", page, false)).toBe("empty");
  });

  it("validates mailto and tel links", () => {
    expect(validateMailto("mailto:hello@example.com?subject=Hi").valid).toBe(true);
    expect(validateMailto("mailto:a@example.com,b@example.org").valid).toBe(true);
    expect(validateMailto("mailto:?to=x@example.com").valid).toBe(true);
    expect(validateMailto("mailto:not-an-email").valid).toBe(false);
    expect(validateMailto("mailto:").valid).toBe(false);
    expect(validateTel("tel:+1 (555) 010-0100").valid).toBe(true);
    expect(validateTel("tel:12").valid).toBe(false);
    expect(validateTel("tel:call-us").valid).toBe(false);
  });

  it("checks each URL once, falls back to GET and retries 5xx", async () => {
    const calls: string[] = [];
    const responses: Record<string, HttpResult[]> = {
      "HEAD https://a.test/": [res({ status: 405 })],
      "GET https://a.test/": [res({ ok: true, status: 200 })],
      "HEAD https://b.test/": [res({ status: 500 })],
      "GET https://b.test/": [res({ status: 500 }), res({ status: 502 })],
    };
    const fetcher = (async (url: string, o?: { method?: string }) => {
      const key = `${o?.method ?? "GET"} ${url}`;
      calls.push(key);
      return responses[key].shift() ?? res({ status: 599 });
    }) as never;
    const checker = new LinkChecker({ timeoutMs: 1000, fetcher, retryDelayMs: 0 });
    const [a1, a2] = await Promise.all([checker.check("https://a.test/"), checker.check("https://a.test/#frag")]);
    expect(a1).toBe(a2);
    expect(a1.verdict.status).toBe("PASS");
    expect((await checker.check("https://b.test/")).verdict.status).toBe("FAIL");
    expect(calls.filter((c) => c.endsWith("a.test/"))).toEqual(["HEAD https://a.test/", "GET https://a.test/"]);
  });
});

describe("module planning", () => {
  it("keeps the client-side module list in sync with the engine registry", () => {
    const engine = [...ENGINE_IDS, ...Object.keys(SCENARIO_MODULES)].sort();
    expect([...IMPLEMENTED_MODULE_IDS].sort()).toEqual(engine);
  });

  it("runs selected modules and reports unimplemented ones as NOT EXECUTED", async () => {
    const plan = planExecution(["tabs", "seo", "future-module"]);
    expect(plan.modules.map((m) => m.id)).toEqual(["seo", "tabs", "future-module"]);
    const unknown = await plan.modules[2].run({} as never);
    expect(unknown[0].status).toBe("NOT EXECUTED");
  });

  it("pulls in feature modules for scenario selections and keeps only matching cases", () => {
    const plan = planExecution(["negative"]);
    const ids = plan.modules.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["forms", "search", "login", "newsletter"]));
    expect(ids).not.toContain("tabs");
    expect(plan.keep("forms", "NEGATIVE")).toBe(true);
    expect(plan.keep("forms", "POSITIVE")).toBe(false);
    expect(plan.keep("forms", "FUNCTIONAL")).toBe(false);
    expect(planExecution(["forms"]).keep("forms", "BOUNDARY")).toBe(true);
  });
});

const field = (over: Partial<FormField>): FormField => ({
  qid: "q", tag: "input", type: "text", name: "", label: "", required: false, minLength: null, maxLength: null, min: null, max: null, step: null,
  pattern: null, patternValid: true, autocomplete: "", hasLabel: true, options: [], visible: true, ...over,
});

describe("safe form test data", () => {
  it("uses only the project's test email, never invented addresses", () => {
    expect(safeValueFor(field({ type: "email", name: "email" }), "qa@company.test")).toEqual({ kind: "fill", value: "qa@company.test" });
    expect(safeValueFor(field({ type: "email", name: "email" }), null)).toEqual({ kind: "needs-email" });
    expect(safeValueFor(field({ name: "contact_email" }), null)).toEqual({ kind: "needs-email" });
  });

  it("never fills passwords or files", () => {
    expect(safeValueFor(field({ type: "password" }), "a@b.co").kind).toBe("skip");
    expect(safeValueFor(field({ type: "file" }), "a@b.co").kind).toBe("skip");
  });

  it("respects declared length limits and patterns", () => {
    expect(safeValueFor(field({ name: "zip", maxLength: 3 }), null)).toEqual({ kind: "fill", value: "123" });
    expect(safeValueFor(field({ type: "tel", pattern: "[0-9 ]{7,20}" }), null)).toEqual({ kind: "fill", value: "5550100" });
    expect(safeValueFor(field({ type: "tel" }), null)).toEqual({ kind: "fill", value: "+1 555 0100" });
  });
});

describe("browser error classification", () => {
  it.each([
    ["page.goto: net::ERR_NAME_NOT_RESOLVED at https://x", "DNS"],
    ["page.goto: NS_ERROR_UNKNOWN_HOST", "DNS"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "SSL"],
    ["SSL_ERROR_BAD_CERT_DOMAIN", "SSL"],
    ["net::ERR_CONNECTION_REFUSED", "CONNECTION"],
    ["Timeout 30000ms exceeded.", "TIMEOUT"],
    ["Target page, context or browser has been closed", "CRASH"],
    ["browserType.launch: Executable doesn't exist at C:\\x", "BROWSER_LAUNCH"],
    ["net::ERR_BLOCKED_BY_CLIENT", "BLOCKED"],
  ])("%s → %s", (message, kind) => {
    expect(classifyBrowserError(new Error(message)).kind).toBe(kind);
  });
});

describe("crawl and test-run validation", () => {
  it("parses crawl configuration with limits", () => {
    const ok = parseCrawlConfig({ maxDepth: "2", maxPages: "50", timeoutSeconds: "20", retries: "1", exclusions: "/tag/\n\n/admin", respectRobotsTxt: "on", useSitemap: null, includeSubdomains: null, queryParams: "keep" });
    expect(ok).toMatchObject({ ok: true, config: { maxDepth: 2, maxPages: 50, timeoutMs: 20_000, exclusions: ["/tag/", "/admin"], respectRobotsTxt: true, useSitemap: false, sameDomainOnly: true } });
    const bad = parseCrawlConfig({ maxDepth: "50", maxPages: "0", timeoutSeconds: "1", retries: "9", queryParams: "weird" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["maxDepth", "maxPages", "queryParams", "retries", "timeoutSeconds"]);
  });

  it("validates a test run form", () => {
    const base = { projectId: "p", configurationId: null, name: "", pageIds: ["a", "a"], modules: ["tabs", "links"], browsers: ["webkit", "chromium"], viewports: ["mobile-390x844"], allowFormSubmission: false, maxLinksPerPage: 50, navigationTimeoutSeconds: 30 };
    const ok = parseTestRunForm(base);
    expect(ok).toMatchObject({ ok: true, data: { name: null, pageIds: ["a"], modules: ["links", "tabs"], browsers: ["chromium", "webkit"] } });
    expect(parseTestRunForm({ ...base, pageIds: [] }).ok).toBe(false);
    expect(parseTestRunForm({ ...base, browsers: ["opera"] }).ok).toBe(false);
    expect(parseTestRunForm({ ...base, modules: ["hacking"] }).ok).toBe(false);
  });
});

describe("engine persistence and services", () => {
  let db: LocalDatabaseProvider;
  let store: SqliteEngineStore;
  beforeEach(() => {
    db = createTestDb();
    store = new SqliteEngineStore(db.sqlite);
  });
  afterEach(async () => db.close());

  async function setup() {
    const project = await db.projects.create(projectInput({ websiteUrl: "https://site.test/" }));
    const added = await addManualPages(db, project.id, "https://site.test/a\nhttps://site.test/b");
    expect(added).toEqual({ ok: true, added: 2, existing: 0 });
    const pages = await db.pages.list({ projectId: project.id });
    return { project, pages };
  }

  it("rejects manual URLs outside the project site", async () => {
    const project = await db.projects.create(projectInput({ websiteUrl: "https://site.test/" }));
    expect((await addManualPages(db, project.id, "https://evil.test/x")).ok).toBe(false);
  });

  it("queues a crawl job and refuses a concurrent crawl", async () => {
    const { project } = await setup();
    const raw = { maxDepth: "2", maxPages: "10", timeoutSeconds: "10", retries: "0", queryParams: "strip-tracking", respectRobotsTxt: "on", useSitemap: "on" };
    const first = await startCrawl(db, project.id, raw);
    expect(first.ok).toBe(true);
    expect((db.sqlite.prepare("SELECT COUNT(*) AS c FROM jobs WHERE type = 'crawl.project'").get() as { c: number }).c).toBe(1);
    const second = await startCrawl(db, project.id, raw);
    expect(second).toMatchObject({ ok: false, errors: { form: expect.stringMatching(/already in progress/) } });
    if (first.ok) {
      expect(await db.crawlRuns.requestCancel(first.crawl.id)).toBe(true);
      expect((await db.crawlRuns.getById(first.crawl.id))?.status).toBe("CANCELLED");
      expect((db.sqlite.prepare("SELECT status FROM jobs").get() as { status: string }).status).toBe("CANCELLED");
    }
  });

  it("creates a test run only for pages of the same project", async () => {
    const { project, pages } = await setup();
    const other = await db.projects.create(projectInput({ name: "Other", websiteUrl: "https://other.test/" }));
    const form = { projectId: project.id, configurationId: null, name: "Smoke", pageIds: pages.map((p) => p.id), modules: ["links"], browsers: ["chromium"], viewports: ["desktop-1366x768"], allowFormSubmission: false, maxLinksPerPage: 50, navigationTimeoutSeconds: 30 };
    expect((await createTestRun(db, { ...form, projectId: other.id })).ok).toBe(false);
    const created = await createTestRun(db, form);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const detail = await db.testRuns.getDetail(created.run.id);
    expect(detail).toMatchObject({ status: "PENDING", progressTotal: 2, modules: ["links"], options: { allowFormSubmission: false, navigationTimeoutMs: 30_000 } });
    expect(await db.testRuns.requestCancel(created.run.id)).toBe(true);
    expect((await db.testRuns.getDetail(created.run.id))?.status).toBe("CANCELLED");
  });

  it("stores one case per page and check, with one result per browser/viewport", async () => {
    const { project, pages } = await setup();
    const run = await db.testRuns.createAndEnqueue({ projectId: project.id, configurationId: null, name: null, modules: ["tabs"], browsers: ["chromium", "firefox"], viewports: ["desktop-1366x768"], pageIds: [pages[0].id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 10_000 } });
    const runPageId = store.ensureRunPage(run.id, pages[0].id);
    for (const browser of ["chromium", "firefox"] as const) {
      store.recordOutcome({ runId: run.id, projectId: project.id, pageId: pages[0].id, pageUrl: pages[0].url, runPageId, browser, viewport: "desktop-1366x768", outcome: finalizeOutcome(outcome.pass(spec, "ok", ["verified"])) });
    }
    const cases = await db.testCases.list({ testRunId: run.id });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ code: "TC-0001", resultSummary: [{ status: "PASS", count: 2 }] });
    expect((await db.testRuns.getDetail(run.id))!.counts.PASS).toBe(2);
  });

  it("remembers form submissions so they are never repeated", async () => {
    const { project, pages } = await setup();
    const run = await db.testRuns.createAndEnqueue({ projectId: project.id, configurationId: null, name: null, modules: ["newsletter"], browsers: ["chromium"], viewports: ["desktop-1366x768"], pageIds: [pages[0].id], configurationName: null, options: { allowFormSubmission: true, maxLinksPerPage: 10, navigationTimeoutMs: 10_000 } });
    expect(store.hasFormSubmission(project.id, "newsletter", "fp")).toBe(false);
    store.recordFormSubmission(project.id, run.id, "newsletter", "fp", "https://site.test/");
    expect(store.hasFormSubmission(project.id, "newsletter", "fp")).toBe(true);
  });

  it("fails work abandoned by a dead worker and reports worker status", async () => {
    const { project, pages } = await setup();
    const run = await db.testRuns.createAndEnqueue({ projectId: project.id, configurationId: null, name: null, modules: ["tabs"], browsers: ["chromium"], viewports: ["desktop-1366x768"], pageIds: [pages[0].id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 10_000 } });
    db.sqlite.prepare("UPDATE jobs SET status = 'RUNNING', locked_by = 'dead-worker'").run();
    db.sqlite.prepare("UPDATE test_runs SET status = 'RUNNING'").run();
    expect((await db.workers.status()).online).toBe(false);
    store.heartbeat("live", "host", 1, ["run.execute"], new Date().toISOString());
    expect(await db.workers.status()).toMatchObject({ online: true, handlers: ["run.execute"] });
    expect(store.recoverAbandonedWork(30_000)).toBe(1);
    expect((await db.testRuns.getDetail(run.id))).toMatchObject({ status: "FAILED", errorMessage: expect.stringMatching(/worker stopped/) });
  });
});
