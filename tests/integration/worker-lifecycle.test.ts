import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeCrawlUrl } from "@/lib/crawler/normalize";
import { EngineStore } from "@/lib/database/local/engine-store";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import { PostgresDatabaseProvider } from "@/lib/database/supabase/supabase-database-provider";
import { redactText } from "@/lib/reports/redact";
import { createTestRun } from "@/lib/services/engine";
import { createSupabaseBucket } from "@/lib/storage/select";
import { SupabaseStorageProvider } from "@/lib/storage/supabase-storage-provider";
import { JobQueue } from "@/worker/jobs/job-queue";
import { JOB_HANDLERS } from "@/worker/jobs/registry";
import { runWorker, type WorkerOutcome } from "@/worker/loop";
import { publicLogLine } from "@/worker/runtime";
import { startFixtureSite, type FixtureSite } from "../fixtures/site-server";
import { projectInput } from "../helpers";
import { BUCKET, FakeStorageServer, SECRET } from "../support/fake-storage";
import { createPgTestDatabase, type PgTestDatabase } from "../support/postgres";
import { browserInstalled, INTEGRATION_TIMEOUT } from "./helpers";

/**
 * The GitHub Actions worker lifecycle, simulated locally: the app (owner-scoped provider + createTestRun) queues a run,
 * the real worker loop (worker/loop.ts, as started by `npm run worker -- --once`) claims and executes it in Chromium
 * against a local fixture site, stores screenshots and reports in Supabase Storage (a fake of its HTTP API on
 * 127.0.0.1) and records everything in PostgreSQL (PGlite). No hosted service, no third-party website.
 */

const OWNER = "user-lifecycle";

describe.skipIf(!browserInstalled("chromium"))("worker lifecycle (PostgreSQL + Supabase Storage, simulated)", () => {
  let site: FixtureSite;
  let pg: PgTestDatabase;
  let storageServer: FakeStorageServer;
  let storage: SupabaseStorageProvider;
  let app: OwnerScopedDatabaseProvider;
  let stranger: OwnerScopedDatabaseProvider;
  let store: EngineStore;
  let queue: JobQueue;
  let projectId = "";
  const pageIds: string[] = [];
  const lines: string[] = [];

  // The log as written on GitHub Actions (worker/index.ts): redacted, then web addresses hidden.
  const log = (message: string) => lines.push(publicLogLine(redactText(message)));
  const worker = (o: { deadline?: number | null; signal?: AbortSignal; onLog?: (m: string) => void } = {}): Promise<WorkerOutcome> =>
    runWorker({
      store,
      queue,
      storage,
      handlers: JOB_HANDLERS,
      workerId: "gha-runner:1",
      log: (m) => (log(m), o.onLog?.(m)),
      signal: o.signal ?? new AbortController().signal,
      once: true,
      deadline: o.deadline ?? null,
      pollIntervalMs: 10,
    });
  const jobsFor = (key: string, id: string) => pg.sql.all<{ id: string; type: string; status: string; attempts: number; locked_by: string | null; last_error: string | null }>(`SELECT id, type, status, attempts, locked_by, last_error FROM jobs WHERE payload::jsonb ->> '${key}' = ?`, [id]);
  const queueRun = async (name: string, extra: Record<string, unknown> = {}) => {
    const created = await createTestRun(app, { projectId, configurationId: null, name, pageIds, modules: ["links", "seo", "console"], browsers: ["chromium"], viewports: ["desktop-1366x768"], allowFormSubmission: false, maxLinksPerPage: 50, navigationTimeoutSeconds: 15, ...extra });
    if (!created.ok) throw new Error(JSON.stringify(created.errors));
    return created.run;
  };

  beforeAll(async () => {
    site = await startFixtureSite();
    pg = await createPgTestDatabase();
    storageServer = new FakeStorageServer();
    await storageServer.start();
    storage = new SupabaseStorageProvider(createSupabaseBucket(storageServer.url, SECRET, BUCKET), { maxObjectBytes: 20 * 1024 * 1024, retryDelayMs: 1 });
    const base = new PostgresDatabaseProvider(pg.sql);
    app = new OwnerScopedDatabaseProvider(base, OWNER);
    stranger = new OwnerScopedDatabaseProvider(base, "user-stranger");
    store = new EngineStore(pg.sql);
    queue = new JobQueue(pg.sql);
    projectId = (await app.projects.create(projectInput({ name: "Fixture", websiteUrl: `${site.origin}/` }))).id;
    for (const path of ["/", "/about"]) {
      const url = `${site.origin}${path}`;
      pageIds.push((await app.pages.addManual(projectId, url, normalizeCrawlUrl(url)!)).page.id);
    }
  }, INTEGRATION_TIMEOUT);

  afterAll(async () => {
    await site?.close();
    await storageServer?.stop();
    await pg?.close();
  });

  describe("a run requested in the app", () => {
    let runId = "";
    let outcome: WorkerOutcome;

    beforeAll(async () => {
      const run = await queueRun("Lifecycle", { reportFormats: ["HTML", "EXCEL", "PDF"] });
      runId = run.id;
      expect(await jobsFor("testRunId", runId)).toMatchObject([{ type: "run.execute", status: "PENDING", attempts: 0 }]);
      outcome = await worker();
    }, INTEGRATION_TIMEOUT * 2);

    it("is claimed by the worker with its run id, executed, and then the queue is empty", async () => {
      expect(outcome).toMatchObject({ processed: 2, failed: 0, recovered: 0, stoppedBy: "empty-queue" }); // the run, then its report
      expect(await jobsFor("testRunId", runId)).toMatchObject([{ status: "COMPLETED", attempts: 1, locked_by: null, last_error: null }]);
      expect(lines.some((l) => l.includes(`Run ${runId} COMPLETED`))).toBe(true);
      expect(await pg.sql.all("SELECT * FROM worker_heartbeats")).toEqual([]); // removed on exit
    });

    it("records progress, results and bugs, visible in the app to the owner only", async () => {
      const detail = await app.testRuns.getDetail(runId);
      expect(detail).toMatchObject({ status: "COMPLETED", progressTotal: 2, progressCompleted: 2, errorMessage: null });
      expect(detail!.counts.PASS).toBeGreaterThan(0);
      expect(detail!.counts.FAIL).toBeGreaterThan(0); // the fixture's /missing-page link
      expect(await app.bugs.count({ testRunId: runId })).toBeGreaterThan(0);
      expect(await stranger.testRuns.getDetail(runId)).toBeNull();
      expect(await stranger.testRuns.list()).toEqual([]);
      expect(await stranger.bugs.count({})).toBe(0);
      expect(site.writes).toEqual([]); // nothing was submitted to the website
    });

    it("stores screenshots in the private bucket, linked to the run and readable only through the owner's scope", async () => {
      const keys = [...storageServer.objects.keys()].filter((k) => k.startsWith(`runs/${runId}/`));
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).toMatch(/\.png$/);
        expect(await app.testResults.isKnownArtifact(key), key).toBe(true);
        expect(await stranger.testResults.isKnownArtifact(key), key).toBe(false);
        const bytes = await storage.get(key);
        expect(Buffer.from(bytes!).subarray(1, 4).toString()).toBe("PNG");
      }
      expect(storageServer.requests.every((r) => r.apikey === SECRET)).toBe(true);
    });

    it("generates the selected reports into the bucket and links them to the run", async () => {
      const [bundle] = await app.reports.listBundles({ testRunId: runId });
      expect(bundle).toMatchObject({ status: "READY", errorMessage: null });
      expect(await jobsFor("reportBundleId", bundle.id)).toMatchObject([{ type: "report.generate", status: "COMPLETED" }]);
      const kinds = bundle.files.map((f) => String(f.kind)).sort();
      expect(kinds).toEqual(["BUG_EXCEL", "HTML", "PDF", "TESTING_EXCEL"]);
      for (const kind of kinds) {
        const file = await app.reports.getFile(bundle.id, kind);
        expect(file?.storageKey, kind).toMatch(new RegExp(`^reports/${bundle.id}/`));
        expect((await storage.get(file!.storageKey))?.length, kind).toBeGreaterThan(100);
        expect(await stranger.reports.getFile(bundle.id, kind)).toBeNull();
      }
    });
  });

  it("cancels a pending run without the worker running it", async () => {
    const run = await queueRun("Cancelled while queued");
    expect(await app.testRuns.requestCancel(run.id)).toBe(true);
    expect(await worker()).toMatchObject({ processed: 0, stoppedBy: "empty-queue" });
    expect((await app.testRuns.getDetail(run.id))?.status).toBe("CANCELLED");
    expect(await jobsFor("testRunId", run.id)).toMatchObject([{ status: "CANCELLED", attempts: 0 }]);
  });

  it("stops a running run when the user cancels it", async () => {
    const run = await queueRun("Cancelled while running", { viewports: ["desktop-1366x768", "desktop-1440x900", "mobile-390x844"] });
    let cancel: Promise<boolean> | undefined;
    const outcome = await worker({ onLog: (m) => void (m.startsWith("Running job") && (cancel ??= app.testRuns.requestCancel(run.id))) });
    expect(await cancel).toBe(true);
    expect(outcome).toMatchObject({ processed: 1, failed: 0 });
    const detail = await app.testRuns.getDetail(run.id);
    expect(detail?.status).toBe("CANCELLED");
    expect(detail!.progressCompleted).toBeLessThan(detail!.progressTotal);
    expect((await jobsFor("testRunId", run.id))[0].status).not.toMatch(/PENDING|RUNNING/);
  }, INTEGRATION_TIMEOUT);

  it("stops claiming at the runtime limit, leaving queued work for the next run", async () => {
    const run = await queueRun("After the limit");
    expect(await worker({ deadline: Date.now() - 1 })).toMatchObject({ processed: 0, stoppedBy: "deadline" });
    expect(await jobsFor("testRunId", run.id)).toMatchObject([{ status: "PENDING", attempts: 0 }]);
    expect((await app.testRuns.getDetail(run.id))?.status).toBe("PENDING");
    expect(await app.testRuns.requestCancel(run.id)).toBe(true); // tidy for the next tests
  });

  it("records a failing job as FAILED with its error instead of leaving it running", async () => {
    const job = await queue.enqueue("report.generate", { reportBundleId: "no-such-bundle" }, { maxAttempts: 1 });
    expect(await worker()).toMatchObject({ processed: 1, failed: 1, stoppedBy: "empty-queue" });
    expect(await queue.get(job.id)).toMatchObject({ status: "FAILED", lastError: expect.stringMatching(/not found/) });
  });

  it("fails work left by a worker that was killed (e.g. a cancelled or timed-out workflow run), so nothing stays stuck", async () => {
    const run = await queueRun("Killed worker");
    const claimed = await queue.claim("dead-runner:7", ["run.execute"]);
    expect(claimed?.payload).toEqual({ testRunId: run.id });
    await pg.sql.run("UPDATE test_runs SET status = 'RUNNING' WHERE id = ?", [run.id]);
    const outcome = await worker();
    expect(outcome).toMatchObject({ recovered: 1, processed: 0 });
    expect(await jobsFor("testRunId", run.id)).toMatchObject([{ status: "FAILED", locked_by: null, last_error: "The worker stopped before this job finished." }]);
    expect(await app.testRuns.getDetail(run.id)).toMatchObject({ status: "FAILED", errorMessage: "The worker stopped before this job finished." });
  });

  it("keeps runner logs free of tested-site addresses and credentials", () => {
    expect(lines.length).toBeGreaterThan(5);
    const all = lines.join("\n");
    expect(all).not.toContain(site.origin);
    expect(all).not.toContain("127.0.0.1");
    expect(all).not.toContain(SECRET);
  });
});
