import type { Browser, BrowserContext, Locator } from "playwright";
import { findViewport } from "@/lib/constants/testing";
import type { EngineStore, RunForExecution } from "@/lib/database/local/engine-store";
import { createContext, launchBrowser } from "@/lib/playwright/browsers";
import { describeBrowserError } from "@/lib/playwright/errors";
import { PageSession } from "@/lib/playwright/page-session";
import type { StorageProvider } from "@/lib/storage/provider";
import type { PageTestContext, TestModule } from "@/lib/testing/context";
import { LinkChecker } from "@/lib/testing/link-check";
import { evidence, finalizeOutcome, outcome, type CheckOutcome } from "@/lib/testing/outcome";
import { planExecution } from "@/lib/testing/registry";
import { spec } from "@/lib/testing/modules/helpers";
import { createReferenceLoader } from "./reference-document";
import { createBugsForRun } from "@/lib/bugs/engine";
import { sensitiveMask } from "@/lib/playwright/masking";
import { LocalReportRepository } from "@/lib/database/local/report-repository";
import { finalizeExternalRun } from "@/lib/external-tests/finalize";
import { EXTERNAL_CASES_KEY, EXTERNAL_SINK_KEY, type ExternalObservationInput } from "@/lib/external-tests/module";
import type { BrowserName, EvidenceItem, ReportKind, Viewport } from "@/types";

const MAX_SCREENSHOTS_PER_PAGE_COMBO = 25;
const MODULE_TIMEOUT_MS = 5 * 60_000;

export interface RunExecutorDeps {
  store: EngineStore;
  storage: StorageProvider;
  log: (message: string) => void;
  signal?: AbortSignal;
  /** Overridable for tests. */
  launch?: (browser: BrowserName) => Promise<Browser>;
}

export interface RunSummary {
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  results: number;
  error: string | null;
}

function pageLoadSpec(url: string) {
  return spec("page-load", "load", {
    title: "Page loads successfully",
    section: "Page",
    feature: "Page load",
    element: url,
    steps: [`Navigate to ${url}`, "Wait for the document and load events"],
    expected: "The page responds with a non-error status and renders",
  });
}

/**
 * Ordered background writes for code paths that are synchronous by design (recording outcomes, progress, external
 * observations). Writes run one after another in the order they were added; `flush` waits for all of them and logs
 * (instead of throwing) any that failed, so one bad write never stops the run — as before, when each failed write was
 * contained by the page that made it.
 */
function writeQueue(log: (message: string) => void) {
  let tail: Promise<void> = Promise.resolve();
  const errors: string[] = [];
  return {
    add(write: () => Promise<unknown>) {
      tail = tail.then(write).then(
        () => undefined,
        (error: unknown) => void errors.push(error instanceof Error ? error.message.split("\n")[0] : String(error)),
      );
    },
    async flush() {
      await tail;
      const failed = errors.splice(0);
      if (failed.length) log(`${failed.length} write(s) for this run failed; first: ${failed[0]}`);
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms / 1000}s`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Executes a queued test run:
 * pages × browsers × viewports × modules. Every failure is contained: a browser that cannot
 * launch, a page that cannot load, or a module that throws produces NOT EXECUTED / FAIL records
 * for that unit only, and the run continues.
 */
export async function executeRun(runId: string, deps: RunExecutorDeps): Promise<RunSummary> {
  const { store, log } = deps;
  const run = await store.getRunForExecution(runId);
  if (!run) return { status: "FAILED", results: 0, error: "Test run not found" };
  if (run.status !== "PENDING") return { status: "FAILED", results: 0, error: `Run is ${run.status}, not PENDING` };

  const viewports = run.snapshot.viewports.map((id) => findViewport(id)).filter((v): v is Viewport => !!v);
  const browsers = run.snapshot.browsers;
  const plan = planExecution(run.snapshot.modules);
  const total = run.pages.length * browsers.length * viewports.length;
  if (total === 0) {
    await store.finishRun(runId, "FAILED", "Nothing to execute: the run has no pages, browsers or viewports.");
    return { status: "FAILED", results: 0, error: "Nothing to execute" };
  }

  await store.markRunRunning(runId, total);
  log(`Run ${runId}: ${run.pages.length} pages × ${browsers.length} browsers × ${viewports.length} viewports, ${plan.modules.length} modules`);

  const writes = writeQueue(log);
  const linkChecker = new LinkChecker({ timeoutMs: Math.min(run.options.navigationTimeoutMs, 20_000) });
  // The ledger is read once per run (modules ask synchronously); submissions made during the run are added to it
  // at once and saved in order.
  const submitted = new Set((await store.listFormSubmissions(run.projectId)).map((s) => `${s.kind}|${s.fingerprint}`));
  const formLedger = {
    hasSubmitted: (kind: string, fp: string) => submitted.has(`${kind}|${fp}`),
    record: (kind: string, fp: string, pageUrl: string) => {
      submitted.add(`${kind}|${fp}`);
      writes.add(() => store.recordFormSubmission(run.projectId, runId, kind, fp, pageUrl));
    },
  };
  const launch = deps.launch ?? ((b: BrowserName) => launchBrowser(b));
  const runPageIds = new Map<string, string>();
  /** Run-scoped state shared by modules across pages (e.g. SEO metadata for duplicate detection). */
  const shared = new Map<string, unknown>();
  if (run.runType === "EXTERNAL_TEST_CASE") {
    // External Test Case Testing: the cases and a sink for per-device observations (see lib/external-tests/module.ts).
    shared.set(EXTERNAL_CASES_KEY, await store.getExternalCases(runId));
    shared.set(EXTERNAL_SINK_KEY, (o: ExternalObservationInput) => writes.add(() => store.saveExternalObservation(runId, o)));
  }
  const finalizeExternal = async (reason: string | null) => {
    if (run.runType !== "EXTERNAL_TEST_CASE") return;
    try {
      await finalizeExternalRun(store.sql, deps.storage, runId, reason);
    } catch (error) {
      log(`Finalizing external test cases for run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const referenceDocument = createReferenceLoader(store, deps.storage, run.projectId);
  let completed = 0;
  let resultCount = 0;
  let cancelled = false;
  /** Re-reads the run's cancel flag; `isCancelled` (synchronous, used by modules) reports the latest reading. */
  const refreshCancelled = async () => {
    if (!cancelled && (deps.signal?.aborted || (await store.isRunCancelRequested(runId)))) cancelled = true;
    return cancelled;
  };
  const isCancelled = () => {
    if (deps.signal?.aborted) cancelled = true;
    return cancelled;
  };
  // Also checked every second, so a long module notices a cancellation without waiting for the next page.
  const cancelPoll = setInterval(() => void refreshCancelled().catch(() => undefined), 1000);
  cancelPoll.unref?.();
  const progress = (fields: Parameters<EngineStore["updateRunProgress"]>[1]) => writes.add(() => store.updateRunProgress(runId, fields));

  const record = (page: { id: string; url: string }, browser: BrowserName, viewport: Viewport, o: CheckOutcome) => {
    const finalized = finalizeOutcome(o);
    writes.add(async () => {
      let runPageId = runPageIds.get(page.id);
      if (!runPageId) {
        runPageId = await store.ensureRunPage(runId, page.id);
        runPageIds.set(page.id, runPageId);
      }
      await store.recordOutcome({ runId, projectId: run.projectId, pageId: page.id, pageUrl: page.url, runPageId, browser, viewport: o.viewportOverride ?? viewport.id, outcome: finalized });
    });
    resultCount++;
  };

  /** Records NOT EXECUTED for every selected module of a page/combo that could not be tested. */
  const recordNotExecuted = (page: { id: string; url: string }, browser: BrowserName, viewport: Viewport, reason: string, isPrimary: boolean) => {
    for (const m of plan.modules) {
      if (m.scope === "page" && !isPrimary) continue;
      record(page, browser, viewport, outcome.notExecuted(spec(m.id, "page-unavailable", { title: `${m.id} checks`, feature: m.id, element: page.url, steps: [], expected: "Module executes" }), reason));
    }
  };

  try {
    for (const [bi, browserName] of browsers.entries()) {
      if (await refreshCancelled()) break;
      let browser: Browser | null = null;
      try {
        progress({ currentTest: `Launching ${browserName}` });
        browser = await launch(browserName);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`Browser ${browserName} failed to launch: ${reason}`);
        for (const [vi, viewport] of viewports.entries()) {
          for (const page of run.pages) {
            record(page, browserName, viewport, outcome.notExecuted(pageLoadSpec(page.url), `Browser could not be started: ${reason}`));
            recordNotExecuted(page, browserName, viewport, `${browserName} could not be started.`, bi === 0 && vi === 0);
            completed++;
          }
        }
        progress({ completed });
        continue;
      }

      for (const [vi, viewport] of viewports.entries()) {
        if (await refreshCancelled()) break;
        let context: BrowserContext | null = null;
        try {
          context = await createContext(browser, { viewport });
        } catch (error) {
          const reason = describeBrowserError({ kind: "UNKNOWN", message: error instanceof Error ? error.message : String(error) });
          for (const page of run.pages) {
            record(page, browserName, viewport, outcome.notExecuted(pageLoadSpec(page.url), `Browser context could not be created: ${reason}`));
            completed++;
          }
          progress({ completed });
          continue;
        }

        for (const page of run.pages) {
          if (await refreshCancelled()) break;
          const isPrimary = bi === 0 && vi === 0;
          progress({ currentPageUrl: page.url, currentTest: `Loading page (${browserName} ${viewport.width}×${viewport.height})` });
          try {
            await testPage({ run, page, browserName, viewport, context, isPrimary, plan, deps, linkChecker, formLedger, record, recordNotExecuted, isCancelled, refreshCancelled, progress, shared, referenceDocument });
          } catch (error) {
            // An unexpected error on one page must not stop the other pages, browsers or viewports.
            const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
            log(`Page ${page.url} (${browserName} ${viewport.id}) stopped: ${reason}`);
            try {
              record(page, browserName, viewport, outcome.notExecuted(spec("page-load", "page-error", { title: "Page testing completed", section: "Page", feature: "Page load", element: page.url, steps: [], expected: "All selected modules run on the page" }), `Testing this page stopped with an unexpected error; remaining checks were not executed: ${reason}`));
            } catch {
              /* the run may have been deleted; the outer handler reports it */
            }
          }
          completed++;
          progress({ completed });
        }
        await context.close().catch(() => undefined);
      }
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Run ${runId} failed: ${message}`);
    clearInterval(cancelPoll);
    await writes.flush();
    await finalizeExternal(`This test case was not executed because the run stopped: ${message}`);
    await store.finishRun(runId, "FAILED", message);
    await store.recordActivity(run.projectId, "test_run", runId, "failed", `Test run failed: ${message.slice(0, 200)}`);
    return { status: "FAILED", results: resultCount, error: message };
  }
  clearInterval(cancelPoll);

  // Cross-page checks (e.g. duplicate titles) once every page has been visited.
  if (!cancelled && browsers.length && viewports.length) {
    for (const mod of plan.modules) {
      if (!mod.afterRun) continue;
      try {
        for (const item of await mod.afterRun(shared)) {
          if (plan.keep(item.outcome.spec.module, item.outcome.spec.scenarioType)) record(item.page, browsers[0], viewports[0], item.outcome);
        }
      } catch (error) {
        log(`afterRun for ${mod.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Every recorded outcome, observation and progress update is stored before results are read back.
  await writes.flush();

  // Turn verified failures (FAIL with evidence) into bugs, deduplicated against the project's existing bugs.
  try {
    const bugSummary = await createBugsForRun(store.sql, runId);
    log(`Run ${runId}: ${bugSummary.created} new bug(s), ${bugSummary.updated} existing bug(s) seen again, ${bugSummary.reopened} reopened`);
  } catch (error) {
    log(`Bug creation for run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  await finalizeExternal(cancelled ? "The execution was cancelled before this test case ran." : null);
  for (const id of runPageIds.values()) await store.finishRunPage(id, cancelled ? "CANCELLED" : "COMPLETED", null);
  const status = cancelled ? "CANCELLED" : "COMPLETED";
  await store.finishRun(runId, status, null);
  await store.recordActivity(run.projectId, "test_run", runId, status === "CANCELLED" ? "cancelled" : "completed", `Test run ${status === "CANCELLED" ? "cancelled" : "completed"}: ${resultCount} results recorded across ${completed} page/browser/viewport units`);

  // Reports selected for the run are queued as a separate job, so a report failure never affects the run.
  const formats = run.options.reports?.formats ?? [];
  if (status === "COMPLETED" && formats.length) {
    try {
      const kinds = formats.flatMap((f): ReportKind[] => (f === "EXCEL" ? ["TESTING_EXCEL", "BUG_EXCEL"] : [f]));
      const bundle = await new LocalReportRepository(store.sql).requestBundle(runId, kinds);
      log(`Run ${runId}: report ${bundle.id} queued (${kinds.join(", ")})`);
    } catch (error) {
      log(`Could not queue the report for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { status, results: resultCount, error: null };
}

interface PageJob {
  run: RunForExecution;
  page: { id: string; url: string };
  browserName: BrowserName;
  viewport: Viewport;
  context: BrowserContext;
  isPrimary: boolean;
  plan: ReturnType<typeof planExecution>;
  deps: RunExecutorDeps;
  linkChecker: LinkChecker;
  formLedger: PageTestContext["formLedger"];
  record: (page: { id: string; url: string }, browser: BrowserName, viewport: Viewport, o: CheckOutcome) => void;
  recordNotExecuted: (page: { id: string; url: string }, browser: BrowserName, viewport: Viewport, reason: string, isPrimary: boolean) => void;
  isCancelled: () => boolean;
  refreshCancelled: () => Promise<boolean>;
  progress: (fields: { completed?: number; currentPageUrl?: string | null; currentTest?: string | null }) => void;
  shared: Map<string, unknown>;
  referenceDocument: PageTestContext["referenceDocument"];
}

async function testPage(job: PageJob) {
  const { run, page, browserName, viewport, context, deps } = job;
  const timeout = run.options.navigationTimeoutMs;
  let session: PageSession;
  try {
    session = await PageSession.open(context);
  } catch (error) {
    job.record(page, browserName, viewport, outcome.notExecuted(pageLoadSpec(page.url), `Browser tab could not be opened: ${error instanceof Error ? error.message : String(error)}`));
    job.recordNotExecuted(page, browserName, viewport, "Browser tab could not be opened.", job.isPrimary);
    return;
  }

  let screenshots = 0;
  const screenshotFailures: string[] = [];
  let current = session;
  /**
   * Stores a screenshot as evidence: the viewport (default), one element, or the full page.
   * Password, payment and other sensitive fields are masked in the image.
   */
  const capture = async (label: string, target?: Locator, options: { fullPage?: boolean } = {}): Promise<EvidenceItem | null> => {
    const p = current.page;
    if ((screenshots >= MAX_SCREENSHOTS_PER_PAGE_COMBO && !options.fullPage) || p.isClosed()) return null;
    const kind = target ? "ELEMENT" : options.fullPage ? "FULL_PAGE" : "VIEWPORT";
    try {
      const mask = sensitiveMask(p);
      const buffer = target ? await target.screenshot({ timeout: 5_000, mask }) : await p.screenshot({ timeout: 15_000, fullPage: !!options.fullPage, mask });
      screenshots++;
      const key = `runs/${run.id}/${page.id}/${browserName}-${viewport.id}/${String(screenshots).padStart(2, "0")}-${kind.toLowerCase()}.png`;
      await deps.storage.put(key, new Uint8Array(buffer), { contentType: "image/png" });
      await deps.store.saveScreenshot({ runId: run.id, pageId: page.id, storageKey: key, browser: browserName, viewport: viewport.id, width: viewport.width, height: viewport.height, kind, label });
      return { type: "screenshot", label: `${label} (${kind.toLowerCase().replace("_", "-")})`, storageKey: key };
    } catch (error) {
      // Recorded below as an evidence-capture result; the check itself continues without the image.
      screenshotFailures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      return null;
    }
  };
  const evidenceSpec = spec("page-load", "evidence-capture", {
    title: "Screenshot evidence captured",
    section: "Page",
    feature: "Evidence",
    element: page.url,
    steps: ["Capture screenshots requested by the checks on this page"],
    expected: "Every requested screenshot is stored",
  });
  const reportScreenshotFailures = () => {
    if (!screenshotFailures.length) return;
    job.record(page, browserName, viewport, outcome.notExecuted(evidenceSpec, `${screenshotFailures.length} screenshot(s) could not be captured; the affected checks were recorded without an image. ${screenshotFailures.slice(0, 5).join("; ")}`));
  };

  const nav = await session.navigate(page.url, timeout);
  const loadSpec = pageLoadSpec(page.url);
  if (!nav.ok) {
    const shot = nav.status !== null ? await capture("Page load result") : null;
    const ev = [evidence.http("Navigation", `URL: ${page.url}\nFinal URL: ${nav.finalUrl}\nStatus: ${nav.status ?? "none"}\nError: ${nav.error ? describeBrowserError(nav.error) : "—"}`), ...(shot ? [shot] : [])];
    let reason: string;
    if (nav.status !== null && nav.status >= 400) {
      job.record(page, browserName, viewport, outcome.fail(loadSpec, `Page returned HTTP ${nav.status}`, ev));
      reason = `Page returned HTTP ${nav.status}.`;
    } else if (nav.error && (nav.error.kind === "SSL" || nav.error.kind === "DNS" || nav.error.kind === "INVALID_URL")) {
      job.record(page, browserName, viewport, outcome.fail(loadSpec, describeBrowserError(nav.error), ev));
      reason = describeBrowserError(nav.error);
    } else {
      job.record(page, browserName, viewport, outcome.warn(loadSpec, nav.error ? describeBrowserError(nav.error) : "Page did not load", { evidence: ev }));
      reason = nav.error ? describeBrowserError(nav.error) : "Page did not load.";
    }
    job.recordNotExecuted(page, browserName, viewport, `Page could not be tested: ${reason}`, job.isPrimary);
    reportScreenshotFailures();
    await session.close();
    return;
  }

  const loadShot = await capture("Page after load");
  job.record(page, browserName, viewport, outcome.pass(loadSpec, `Loaded ${nav.finalUrl}${nav.status ? ` (HTTP ${nav.status})` : ""} in ${nav.durationMs} ms`, [`Response status ${nav.status ?? "n/a"}`, `Final URL ${nav.finalUrl}`], { evidence: loadShot ? [loadShot] : [], durationMs: nav.durationMs }));

  const loadObservations = {
    console: session.console.map((c) => ({ level: c.level, message: c.message, sourceUrl: c.sourceUrl })),
    pageErrors: [...session.pageErrors],
    network: session.network.map((n) => ({ url: n.url, method: n.method, resourceType: n.resourceType, status: n.status, failure: n.failure })),
  };
  // Load-time console/network activity, tagged with browser and viewport (interaction noise from the tests is excluded).
  await deps.store.saveObservations({
    runId: run.id,
    pageId: page.id,
    browser: browserName,
    viewport: viewport.id,
    console: [
      ...session.console,
      ...session.pageErrors.map((message) => ({ level: "error" as const, message: `[uncaught] ${message}`, sourceUrl: nav.finalUrl, line: null, column: null, at: new Date().toISOString() })),
    ],
    network: session.network,
  });

  const ctx: PageTestContext = {
    get session() {
      return current;
    },
    pageId: page.id,
    url: nav.finalUrl,
    browser: browserName,
    viewport,
    options: run.options,
    project: { websiteUrl: run.project.websiteUrl, testEmail: run.project.testEmail, figmaUrl: run.project.figmaUrl },
    selectedModules: new Set(run.snapshot.modules),
    linkChecker: job.linkChecker,
    formLedger: job.formLedger,
    isPrimaryCombo: job.isPrimary,
    loadObservations,
    shared: job.shared,
    referenceDocument: job.referenceDocument,
    capture,
    async reload() {
      if (current.crashed || current.page.isClosed()) {
        await current.close();
        current = await PageSession.open(context);
      }
      current.setGuard(false);
      return (await current.navigate(page.url, timeout)).ok;
    },
    isCancelled: job.isCancelled,
    setCurrentTest(label: string) {
      job.progress({ currentTest: label.slice(0, 200) });
    },
  };

  let failures = 0;
  for (const mod of job.plan.modules) {
    if (await job.refreshCancelled()) break;
    if (mod.scope === "page" && !job.isPrimary) continue;
    ctx.setCurrentTest(`${mod.id} (${browserName} ${viewport.width}×${viewport.height})`);
    const outcomes = await runModule(mod, ctx);
    for (const o of outcomes) {
      if (!job.plan.keep(o.spec.module, o.spec.scenarioType)) continue;
      job.record(page, browserName, viewport, o);
      if (o.status === "FAIL") failures++;
    }
    // Leave the page in a clean state for the next module.
    if (current.page.url() !== nav.finalUrl || current.crashed) await ctx.reload();
  }
  // A full-page screenshot accompanies any failures on this page/browser/viewport as bug evidence.
  if (failures > 0 && !(await job.refreshCancelled())) {
    if (await ctx.reload()) await capture("Full page after testing", undefined, { fullPage: true });
  }
  reportScreenshotFailures();
  await current.close();
}

async function runModule(module: TestModule, ctx: PageTestContext): Promise<CheckOutcome[]> {
  try {
    return await withTimeout(module.run(ctx), MODULE_TIMEOUT_MS, `Module ${module.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    if (ctx.session.crashed) {
      return [outcome.notExecuted(spec(module.id, "crash", { title: `${module.id} checks`, feature: module.id, element: ctx.url, steps: [], expected: "Module completes" }), `The browser page crashed while testing: ${message}`)];
    }
    return [outcome.notExecuted(spec(module.id, "error", { title: `${module.id} checks`, feature: module.id, element: ctx.url, steps: [], expected: "Module completes" }), `The module stopped with an error and its remaining checks were not executed: ${message}`)];
  }
}
