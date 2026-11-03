import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createBugsForRun } from "@/lib/bugs/engine";
import { DEFAULT_CRAWL_CONFIG } from "@/lib/constants/crawl";
import type { CrawledPage } from "@/lib/crawler/crawler";
import { EngineStore } from "@/lib/database/local/engine-store";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import type { DatabaseProvider } from "@/lib/database/provider";
import type { SqlExecutor } from "@/lib/database/sql/executor";
import { PostgresDatabaseProvider } from "@/lib/database/supabase/supabase-database-provider";
import { finalizeExternalRun } from "@/lib/external-tests/finalize";
import type { NewExternalExecution } from "@/lib/external-tests/types";
import { loadReportData } from "@/lib/reports/data";
import { generateReportBundle } from "@/lib/reports/generate";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { spec } from "@/lib/testing/modules/helpers";
import { evidence, finalizeOutcome, outcome } from "@/lib/testing/outcome";
import { JobQueue } from "@/worker/jobs/job-queue";
import { createTestDb, makeTempDir, projectInput } from "./helpers";
import { createPgTestDatabase, type PgTestDatabase } from "./support/postgres";

/**
 * The whole data path of the app, on SQLite and on PostgreSQL (PGlite with the versioned migrations), through the
 * same code the web app and the worker run: projects, documents, pages, crawls, test runs and job claiming, recorded
 * outcomes with evidence and measurements, bug creation and recurrence, history and run comparison, dashboard,
 * reports, cancellation, External Test Case Testing and project deletion. Every step's results must be identical on
 * both databases (generated ids and timestamps are masked).
 */

interface Backend {
  name: "sqlite" | "postgres";
  sql: SqlExecutor;
  db: DatabaseProvider;
  store: EngineStore;
  queue: JobQueue;
  storage: LocalStorageProvider;
}

let pg: PgTestDatabase;
let lite: LocalDatabaseProvider | undefined;
beforeAll(async () => {
  pg = await createPgTestDatabase();
}, 60_000);
afterAll(async () => {
  await pg.close();
});
afterEach(async () => {
  vi.useRealTimers();
  await lite?.close();
  lite = undefined;
});

const MASK = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"],
  [/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<ts>"],
] as const;
const comparable = (v: unknown) => {
  let text = JSON.stringify(v ?? null);
  for (const [re, to] of MASK) text = text.replace(re, to);
  return JSON.parse(text) as unknown;
};

async function onBoth(scenario: (b: Backend) => Promise<unknown>) {
  await lite?.close();
  lite = createTestDb();
  await pg.reset();
  const backends: Backend[] = [
    { name: "sqlite", sql: lite.sql, db: lite, store: new EngineStore(lite.sql), queue: new JobQueue(lite.sql), storage: new LocalStorageProvider(makeTempDir()) },
    { name: "postgres", sql: pg.sql, db: new PostgresDatabaseProvider(pg.sql), store: new EngineStore(pg.sql), queue: new JobQueue(pg.sql), storage: new LocalStorageProvider(makeTempDir()) },
  ];
  const out: Record<string, unknown> = {};
  for (const b of backends) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    out[b.name] = comparable(await scenario(b));
    vi.useRealTimers();
  }
  return out as { sqlite: unknown; postgres: unknown };
}

/** Advances the fake clock so each step gets a distinct timestamp. */
const tick = () => vi.setSystemTime(new Date(Date.now() + 1000));

const checkSpec = (key: string, title: string) => spec("links", key, { title, feature: "Links", element: "a.cta", steps: ["Open the page", "Check the link"], expected: "The link resolves" });

async function executeRun(b: Backend, projectId: string, pageId: string, pageUrl: string, statuses: ("PASS" | "FAIL")[]) {
  const run = await b.db.testRuns.createAndEnqueue({
    projectId,
    configurationId: null,
    name: `Run ${statuses.join("/")}`,
    modules: ["links"],
    browsers: ["chromium"],
    viewports: ["desktop-1440x900"],
    pageIds: [pageId],
    configurationName: null,
    options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 },
  });
  tick();
  const job = await b.queue.claim("worker-1", ["run.execute"]);
  await b.store.markRunRunning(run.id, 1);
  const runPageId = await b.store.ensureRunPage(run.id, pageId);
  const key = `runs/${run.id}/${pageId}/chromium-desktop-1440x900/01-viewport.png`;
  await b.storage.put(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await b.store.saveScreenshot({ runId: run.id, pageId, storageKey: key, browser: "chromium", viewport: "desktop-1440x900", width: 1440, height: 900, label: "Page after load" });
  await b.store.saveObservations({
    runId: run.id,
    pageId,
    browser: "chromium",
    viewport: "desktop-1440x900",
    console: [{ level: "error", message: "Uncaught TypeError", sourceUrl: pageUrl, line: 1, column: 2, at: new Date().toISOString() }],
    network: [{ url: `${pageUrl}missing.js`, method: "GET", resourceType: "script", status: 404, failure: null, durationMs: 12, at: new Date().toISOString() }],
  });
  for (const [i, status] of statuses.entries()) {
    tick();
    const s = checkSpec(`link-${i}`, `Link ${i} resolves`);
    const details = [{ table: "link_results" as const, values: { href: `/target-${i}`, resolved_url: `${pageUrl}target-${i}`, link_text: `Target ${i}`, is_external: 0, http_status: status === "PASS" ? 200 : 404, checked_at: new Date().toISOString() } }];
    const o =
      status === "PASS"
        ? outcome.pass(s, "Resolved with HTTP 200", ["HTTP 200"], { details })
        : outcome.fail(s, "Resolved with HTTP 404", [evidence.http("Request", "GET /target → 404"), { type: "screenshot", label: "Page after load", storageKey: key }], { details });
    await b.store.recordOutcome({ runId: run.id, projectId, pageId, pageUrl, runPageId, browser: "chromium", viewport: "desktop-1440x900", outcome: finalizeOutcome(o) });
  }
  await b.store.updateRunProgress(run.id, { completed: 1, currentPageUrl: null, currentTest: null });
  await b.store.finishRunPage(runPageId, "COMPLETED", null);
  await b.store.finishRun(run.id, "COMPLETED", null);
  await b.queue.complete(job!.id);
  const bugs = await createBugsForRun(b.sql, run.id);
  return { run, job, bugs };
}

describe("PostgreSQL workflow parity (same code, both databases)", () => {
  it("projects, documents, pages and crawling", async () => {
    const r = await onBoth(async (b) => {
      const p = await b.db.projects.create(projectInput({ name: "Alpha shop" }), "user-alice");
      tick();
      await b.db.projects.create(projectInput({ name: "beta Blog", websiteUrl: "https://beta.test/" }), "user-alice");
      tick();
      await b.db.projects.create(projectInput({ name: "Gamma", websiteUrl: "https://gamma.test/" }), "user-bob");
      await b.db.documents.create({ projectId: p.id, kind: "REFERENCE", fileName: "ref.pdf", mimeType: "application/pdf", sizeBytes: 10, storageKey: `projects/${p.id}/documents/ref.pdf`, checksumSha256: "x" });
      const first = await b.db.pages.addManual(p.id, "https://example.test/", "https://example.test/");
      const again = await b.db.pages.addManual(p.id, "https://example.test/", "https://example.test/");
      const second = await b.db.pages.addManual(p.id, "https://example.test/pricing", "https://example.test/pricing");
      const deselected = await b.db.pages.setSelected(p.id, [second.page.id], false);
      const crawl = await b.db.crawlRuns.createAndEnqueue(p.id, "https://example.test/", DEFAULT_CRAWL_CONFIG);
      const job = await b.queue.claim("worker-1", ["crawl.project"]);
      await b.store.markCrawlRunning(crawl.id);
      const crawled: Omit<CrawledPage, "depth"> = { url: "https://example.test/about", normalizedUrl: "https://example.test/about", finalUrl: null, sources: ["content"], crawlStatus: "CRAWLED", httpStatus: 200, contentType: "text/html", title: "About", name: "About", description: null, pageType: "OTHER", pageTypeConfidence: 0.5, errorMessage: null };
      await b.store.upsertCrawledPage(p.id, crawl.id, { ...crawled, depth: 2 });
      await b.store.upsertCrawledPage(p.id, crawl.id, { ...crawled, depth: 1, title: "About us" }); // update path: depth = smaller of the two
      await b.store.updateCrawlProgress(crawl.id, { discovered: 3, crawled: 2, failed: 0, skipped: 1, currentUrl: null, currentDepth: 1, maxDepthReached: 2 });
      const cancelCheck = await b.store.isCrawlCancelRequested(crawl.id);
      await b.store.finishCrawl(crawl.id, "COMPLETED", null);
      await b.queue.complete(job!.id);
      return {
        list: (await b.db.projects.list({ ownerId: "user-alice", sort: "name" })).map((x) => [x.name, x.pageCount, x.referenceDocument?.fileName ?? null]),
        search: (await b.db.projects.list({ search: "ALPHA" })).map((x) => x.name),
        count: [await b.db.projects.count(), await b.db.projects.count("user-alice")],
        detail: await b.db.projects.getById(p.id),
        manual: [first.created, again.created, second.created, deselected],
        pages: (await b.db.pages.list({ projectId: p.id })).map((x) => [x.url, x.depth, x.title, x.isSelected, x.discoverySources]),
        pageSearch: await b.db.pages.count({ projectId: p.id, search: "PRICING" }),
        crawl: await b.db.crawlRuns.latest(p.id),
        crawls: (await b.db.crawlRuns.list(p.id)).length,
        claimed: job?.type,
        cancelCheck,
      };
    });
    expect(r.postgres).toEqual(r.sqlite);
    expect(r.sqlite).toMatchObject({ list: [["Alpha shop", 3, "ref.pdf"], ["beta Blog", 0, null]], search: ["Alpha shop"], count: [3, 2], manual: [true, false, true, 1], pageSearch: 1, claimed: "crawl.project", cancelCheck: false });
  });

  it("test runs, job claiming, outcomes, bugs, history, comparison and dashboard", async () => {
    const r = await onBoth(async (b) => {
      const p = await b.db.projects.create(projectInput({ name: "Alpha" }), "user-alice");
      const { page } = await b.db.pages.addManual(p.id, "https://example.test/", "https://example.test/");
      const first = await executeRun(b, p.id, page.id, page.url, ["PASS", "FAIL"]);
      tick();
      const second = await executeRun(b, p.id, page.id, page.url, ["FAIL", "FAIL"]);
      const bugs = await b.db.bugs.list({ projectId: p.id });
      const bugDetail = await b.db.bugs.getDetail(bugs[0].id);
      const updated = await b.db.bugs.updateStatus(bugs[0].id, "RESOLVED", "fixed");
      tick();
      const third = await executeRun(b, p.id, page.id, page.url, ["FAIL"]); // recurrence reopens the resolved bug
      return {
        firstBugs: first.bugs,
        secondBugs: second.bugs,
        thirdBugs: third.bugs,
        claimed: [first.job?.type, first.job?.attempts],
        detail: await b.db.testRuns.getDetail(second.run.id),
        counts: await b.db.testRuns.countsByRun([first.run.id, second.run.id]),
        results: (await b.db.testResults.listByRun(second.run.id)).map((x) => [x.caseCode, x.status, x.evidence.length]),
        resultCount: await b.db.testResults.countByRun(second.run.id, { status: "FAIL" }),
        details: await b.db.testResults.listDetails(second.run.id, "links"),
        artifact: await b.db.testResults.isKnownArtifact(`runs/${second.run.id}/${page.id}/chromium-desktop-1440x900/01-viewport.png`),
        // Sorted: created_at comes from the database clock, so equal-second ordering is timing, not behaviour.
        cases: (await b.db.testCases.list({ testRunId: second.run.id })).map((x) => [x.code, x.resultSummary]).sort(),
        bugList: bugs.map((x) => [x.code, x.severity, x.status, x.occurrenceCount]),
        bugDetail: { evidence: bugDetail?.evidence.map((e) => e.type), occurrences: bugDetail?.occurrences.length, history: bugDetail?.history.map((h) => h.toStatus) },
        updated: updated?.status,
        reopened: (await b.db.bugs.getDetail(bugs[0].id))?.status,
        facets: await b.db.bugs.facets(p.id),
        related: (await b.db.bugs.related(bugs[0].id)).length,
        bugSearch: await b.db.bugs.count({ search: "LINK" }),
        history: (await b.db.history.listRuns({ projectId: p.id })).map((x) => [x.name, x.totalTests, x.bugs, x.newBugs, x.severity]),
        historySearch: await b.db.history.countRuns({ search: "run fail" }),
        previous: (await b.db.history.previousRunId(second.run.id)) === first.run.id,
        comparison: await b.db.history.compare(second.run.id, first.run.id),
        metrics: await b.db.dashboard.getMetrics("user-alice"),
        regressions: (await b.db.dashboard.getRegressions(20, "user-alice")).length,
      };
    });
    expect(r.postgres).toEqual(r.sqlite);
    expect(r.sqlite).toMatchObject({ firstBugs: { created: 1 }, claimed: ["run.execute", 1], updated: "RESOLVED", reopened: "REOPENED", previous: true });
  });

  it("reports, cancellation, external test cases and project deletion", async () => {
    const r = await onBoth(async (b) => {
      const p = await b.db.projects.create(projectInput({ name: "Alpha" }), "user-alice");
      const { page } = await b.db.pages.addManual(p.id, "https://example.test/", "https://example.test/");
      const { run } = await executeRun(b, p.id, page.id, page.url, ["PASS", "FAIL"]);
      const data = await loadReportData(b.sql, run.id);
      const bundle = await b.db.reports.requestBundle(run.id, ["HTML", "TESTING_EXCEL", "BUG_EXCEL"]);
      const reportJob = await b.queue.claim("worker-1", ["report.generate"]);
      const generated = await generateReportBundle(b.sql, b.storage, bundle.id, { render: async () => new TextEncoder().encode("%PDF") }, ["HTML", "TESTING_EXCEL", "BUG_EXCEL"]);
      const file = await b.db.reports.getFile(bundle.id, "HTML");

      // Cancellation: a pending run is cancelled with its queued job; a running run is only flagged.
      const pending = await b.db.testRuns.createAndEnqueue({ projectId: p.id, configurationId: null, name: "To cancel", modules: ["links"], browsers: ["chromium"], viewports: ["desktop-1440x900"], pageIds: [page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 } });
      const cancelledPending = await b.db.testRuns.requestCancel(pending.id);
      const queuedAfterCancel = await b.queue.claim("worker-1", ["run.execute"]);
      const cancelledAgain = await b.db.testRuns.requestCancel(pending.id);

      // External Test Case Testing: create, observe, finalize (the source workbook is absent, which is recorded).
      const externalRunId = await b.db.externalTests.create({
        projectId: p.id,
        name: "External",
        websiteUrl: "https://example.test/",
        pageId: page.id,
        source: { kind: "UPLOAD", name: "cases.xlsx", storageKey: "external-drafts/none/source.xlsx" },
        worksheet: "Sheet1",
        headerRow: 1,
        mapping: { title: 1 },
        outputMode: "NEW_SHEET",
        browsers: ["chromium"],
        viewports: ["desktop-1440x900"],
        allowFormSubmission: false,
        navigationTimeoutMs: 1000,
        cases: [{ rowNumber: 2, caseRef: "TC1", title: "Open home", steps: "Open", expected: "Loads", url: null, testData: null, preconditions: null }],
      } as unknown as NewExternalExecution);
      const cases = await b.store.getExternalCases(externalRunId);
      await b.store.saveExternalObservation(externalRunId, { caseId: cases[0].id, browser: "chromium", viewport: "desktop-1440x900", status: "PASS", actual: "Loaded", screenshotKey: null, durationMs: 5 });
      await b.store.saveExternalObservation(externalRunId, { caseId: cases[0].id, browser: "chromium", viewport: "desktop-1440x900", status: "FAIL", actual: "Retry: failed", screenshotKey: null, durationMs: 6 });
      await finalizeExternalRun(b.sql, b.storage, externalRunId);
      const external = await b.db.externalTests.get(externalRunId);
      const externalCases = await b.db.externalTests.listCases(externalRunId);

      const prefixes = await b.db.projects.storagePrefixes(p.id);
      const recovered = await b.store.recoverAbandonedWork(30_000);
      const deleted = await b.db.projects.delete(p.id);
      return {
        data: { counts: data.counts, bugs: data.bugs.length, pages: data.pages.map((x) => x.counts), links: data.links.length },
        bundle: [bundle.status, reportJob?.type, generated.status, generated.files.map((f) => `${f.kind}:${f.status}`), file?.fileName],
        bundles: (await b.db.reports.listBundles({ projectId: p.id })).map((x) => [x.status, x.files.map((f) => f.kind)]),
        reportSearch: await b.db.reports.countBundles({ search: "ALPHA" }),
        cancel: [cancelledPending, queuedAfterCancel, cancelledAgain],
        external: { status: external?.runStatus, counts: external?.counts, outputError: !!external?.outputError, cases: externalCases.rows.map((c) => [c.status, c.observations.length]) },
        externalList: (await b.db.externalTests.list({ projectId: p.id })).length,
        prefixes: prefixes.length,
        recovered,
        deleted,
        afterDelete: [await b.db.projects.getById(p.id), await b.db.testRuns.list({ projectId: p.id })],
        activity: (await b.db.activity.list({ limit: 50 })).map((a) => a.action),
      };
    });
    expect(r.postgres).toEqual(r.sqlite);
    expect(r.sqlite).toMatchObject({ cancel: [true, null, false], deleted: true, afterDelete: [null, []] });
  });

  it("worker liveness and abandoned-job recovery", async () => {
    const r = await onBoth(async (b) => {
      const p = await b.db.projects.create(projectInput(), "user-alice");
      const { page } = await b.db.pages.addManual(p.id, "https://example.test/", "https://example.test/");
      const run = await b.db.testRuns.createAndEnqueue({ projectId: p.id, configurationId: null, name: "Crashed", modules: ["links"], browsers: ["chromium"], viewports: ["desktop-1440x900"], pageIds: [page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 } });
      await b.store.heartbeat("worker-dead", "host", 1, ["run.execute"], new Date().toISOString());
      const job = await b.queue.claim("worker-dead", ["run.execute"]);
      await b.store.markRunRunning(run.id, 1);
      vi.setSystemTime(new Date(Date.now() + 120_000)); // the worker stops heart-beating
      await b.store.heartbeat("worker-live", "host", 2, ["run.execute"], new Date().toISOString());
      const recovered = await b.store.recoverAbandonedWork(30_000);
      const failedJob = await b.queue.get(job!.id);
      const retried = await b.queue.fail(job!.id, "boom");
      return { recovered, job: failedJob?.status, retried: retried?.status, run: (await b.db.testRuns.getById(run.id))?.status, worker: await b.db.workers.status() };
    });
    expect(r.postgres).toEqual(r.sqlite);
    expect(r.sqlite).toMatchObject({ recovered: 1, job: "FAILED", run: "FAILED", worker: { online: true } });
  });
});
