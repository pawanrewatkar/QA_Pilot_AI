import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isEmailAllowed, normalizeEmail, parseAllowList } from "@/lib/auth/allow-list";
import { LOCAL_OWNER_ID } from "@/lib/auth/identity-constants";
import { resolveIdentity } from "@/lib/auth/identity";
import { createBugsForRun } from "@/lib/bugs/engine";
import { DEFAULT_CRAWL_CONFIG } from "@/lib/constants/crawl";
import { DEFAULT_REPORT_SECTIONS } from "@/lib/constants/testing";
import { SqliteEngineStore } from "@/lib/database/local/engine-store";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { openSqlite, runMigrations } from "@/lib/database/local/sqlite-client";
import { OwnerScopedDatabaseProvider, ResourceNotFoundError } from "@/lib/database/owner-scoped-provider";
import { MIGRATIONS } from "@/lib/database/schema";
import { generateReportBundle } from "@/lib/reports/generate";
import { createProject } from "@/lib/services/projects";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { finalizeOutcome, outcome, type CaseSpec } from "@/lib/testing/outcome";
import { createTestDb, makeTempDir, projectInput } from "./helpers";

const VIEWPORT = "desktop-1440x900";
const failSpec: CaseSpec = { key: "links:footer:/x", module: "links", title: "Footer link resolves", section: "Footer", scenarioType: "FUNCTIONAL", feature: "Links", element: "a", steps: [], expected: "2xx" };

/** A complete set of resources owned by `ownerId`: project → configuration, document, crawl, run (results, screenshot, bug), report bundle, external execution, activity. */
async function seedOwner(base: LocalDatabaseProvider, storage: LocalStorageProvider, ownerId: string, name: string) {
  const project = await base.projects.create(projectInput({ name, websiteUrl: `https://${name}.test/` }), ownerId);
  const config = await base.testConfigurations.create({
    projectId: project.id, name: "Smoke", scope: "MANUAL_URLS", selectedPageIds: [], manualUrls: [`https://${name}.test/`], modules: ["links"],
    browsers: ["chromium"], viewports: [VIEWPORT], reportFormats: ["EXCEL"], reportSections: DEFAULT_REPORT_SECTIONS,
  });
  const document = await base.documents.create({ projectId: project.id, kind: "REFERENCE", fileName: "ref.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: `projects/${project.id}/documents/ref.pdf`, checksumSha256: "x" });
  const crawl = await base.crawlRuns.createAndEnqueue(project.id, project.websiteUrl, DEFAULT_CRAWL_CONFIG);
  const { page } = await base.pages.addManual(project.id, project.websiteUrl, project.websiteUrl);
  const store = new SqliteEngineStore(base.sqlite);
  const run = await base.testRuns.createAndEnqueue({ projectId: project.id, configurationId: null, name: `${name} run`, modules: ["links"], browsers: ["chromium"], viewports: [VIEWPORT], pageIds: [page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 } });
  base.sqlite.prepare("UPDATE jobs SET status = 'COMPLETED' WHERE json_extract(payload, '$.testRunId') = ?").run(run.id);
  store.markRunRunning(run.id, 1);
  const rp = store.ensureRunPage(run.id, page.id);
  const screenshotKey = `runs/${run.id}/${page.id}/chromium-${VIEWPORT}/01-viewport.png`;
  await storage.put(screenshotKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  store.saveScreenshot({ runId: run.id, pageId: page.id, storageKey: screenshotKey, browser: "chromium", viewport: VIEWPORT, width: 1, height: 1 });
  store.recordOutcome({ runId: run.id, projectId: project.id, pageId: page.id, pageUrl: page.url, runPageId: rp, browser: "chromium", viewport: VIEWPORT, outcome: finalizeOutcome(outcome.fail(failSpec, "404", [{ type: "screenshot", label: "s", storageKey: screenshotKey }])) });
  store.finishRunPage(rp, "COMPLETED", null);
  store.finishRun(run.id, "COMPLETED", null);
  createBugsForRun(base.sqlite, run.id);
  const [bug] = await base.bugs.list({ testRunId: run.id });
  const bundle = await base.reports.requestBundle(run.id);
  await generateReportBundle(base.sqlite, storage, bundle.id, { render: async () => new TextEncoder().encode("%PDF-1.4") });
  const externalRunId = await base.externalTests.create({
    projectId: project.id, name: `${name} external`, websiteUrl: project.websiteUrl, pageId: page.id, source: { kind: "UPLOAD", name: "cases.xlsx", storageKey: `projects/${project.id}/external-test-cases/a.xlsx` },
    worksheet: "Cases", headerRow: 1, mapping: { title: 1, expected: 2 }, outputMode: "NEW_SHEET", browsers: ["chromium"], viewports: [VIEWPORT], allowFormSubmission: false, navigationTimeoutMs: 1000,
    cases: [{ rowNumber: 2, caseRef: "TC1", title: "Case", steps: null, expected: "Page loads", url: null, testData: null, preconditions: null }],
  });
  await base.activity.record({ ownerId, projectId: project.id, entityType: "project", entityId: project.id, action: "created", summary: `${name} created` });
  return { project, config, document, crawl, page, run, screenshotKey, bug, bundle, externalRunId };
}

describe("owner-scoped data access", () => {
  let base: LocalDatabaseProvider;
  let storage: LocalStorageProvider;
  let alice: OwnerScopedDatabaseProvider;
  let bob: OwnerScopedDatabaseProvider;
  let a: Awaited<ReturnType<typeof seedOwner>>;
  let b: Awaited<ReturnType<typeof seedOwner>>;

  beforeEach(async () => {
    base = createTestDb();
    storage = new LocalStorageProvider(makeTempDir());
    a = await seedOwner(base, storage, "user-alice", "alice");
    b = await seedOwner(base, storage, "user-bob", "bob");
    alice = new OwnerScopedDatabaseProvider(base, "user-alice");
    bob = new OwnerScopedDatabaseProvider(base, "user-bob");
  });
  afterEach(async () => base.close());

  it("lets an owner read all of their own resources", async () => {
    expect((await alice.projects.list()).map((p) => p.id)).toEqual([a.project.id]);
    expect(await alice.projects.getById(a.project.id)).not.toBeNull();
    expect(await alice.testConfigurations.getById(a.config.id)).not.toBeNull();
    expect(await alice.documents.getById(a.document.id)).not.toBeNull();
    expect(await alice.crawlRuns.getById(a.crawl.id)).not.toBeNull();
    expect(await alice.testRuns.getDetail(a.run.id)).not.toBeNull();
    expect(await alice.testResults.listByRun(a.run.id)).toHaveLength(1);
    expect(await alice.testResults.isKnownArtifact(a.screenshotKey)).toBe(true);
    expect(await alice.bugs.getDetail(a.bug.id)).not.toBeNull();
    expect(await alice.reports.getFile(a.bundle.id, "PDF")).not.toBeNull();
    expect(await alice.externalTests.get(a.externalRunId)).not.toBeNull();
    expect((await alice.externalTests.listCases(a.externalRunId)).total).toBe(1);
    expect(await alice.history.getRun(a.run.id)).not.toBeNull();
    expect((await alice.activity.list()).map((x) => x.summary)).toEqual(["alice created"]);
  });

  it("returns not-found for every other owner's resource, whatever ID is supplied", async () => {
    expect(await bob.projects.getById(a.project.id)).toBeNull();
    expect(await bob.projects.update(a.project.id, projectInput({ name: "stolen" }))).toBeNull();
    expect(await bob.projects.delete(a.project.id)).toBe(false);
    expect(await bob.projects.storagePrefixes(a.project.id)).toEqual([]);
    expect(await bob.testConfigurations.getById(a.config.id)).toBeNull();
    expect(await bob.testConfigurations.delete(a.config.id)).toBe(false);
    expect(await bob.testConfigurations.listByProject(a.project.id)).toEqual([]);
    expect(await bob.documents.getById(a.document.id)).toBeNull();
    expect(await bob.documents.delete(a.document.id)).toBe(false);
    expect(await bob.documents.listByProject(a.project.id)).toEqual([]);
    expect(await bob.crawlRuns.getById(a.crawl.id)).toBeNull();
    expect(await bob.crawlRuns.latest(a.project.id)).toBeNull();
    expect(await bob.crawlRuns.requestCancel(a.crawl.id)).toBe(false);
    expect(await bob.testRuns.getById(a.run.id)).toBeNull();
    expect(await bob.testRuns.getDetail(a.run.id)).toBeNull();
    expect(await bob.testRuns.requestCancel(a.run.id)).toBe(false);
    expect(await bob.testRuns.countsByRun([a.run.id])).toEqual({});
    expect(await bob.testResults.listByRun(a.run.id)).toEqual([]);
    expect(await bob.testResults.countByRun(a.run.id)).toBe(0);
    expect(await bob.testResults.listDetails(a.run.id, "seo")).toEqual({ rows: [], total: 0 });
    expect(await bob.testResults.isKnownArtifact(a.screenshotKey)).toBe(false);
    expect(await bob.pages.getByIds(a.project.id, [a.page.id])).toEqual([]);
    expect(await bob.pages.setSelected(a.project.id, [a.page.id], false)).toBe(0);
    expect(await bob.pages.remove(a.project.id, [a.page.id])).toBe(0);
    expect(await bob.bugs.getDetail(a.bug.id)).toBeNull();
    expect(await bob.bugs.related(a.bug.id)).toEqual([]);
    expect(await bob.bugs.updateStatus(a.bug.id, "CLOSED", "x")).toBeNull();
    expect(await bob.reports.getBundle(a.bundle.id)).toBeNull();
    expect(await bob.reports.getFile(a.bundle.id, "PDF")).toBeNull();
    expect(await bob.reports.deleteBundle(a.bundle.id)).toBe(false);
    expect(await bob.externalTests.get(a.externalRunId)).toBeNull();
    expect(await bob.externalTests.listCases(a.externalRunId)).toEqual({ rows: [], total: 0 });
    expect(await bob.externalTests.getOutputFile(a.externalRunId)).toBeNull();
    expect(await bob.history.getRun(a.run.id)).toBeNull();
    expect(await bob.history.previousRunId(a.run.id)).toBeNull();
    expect(await bob.history.comparableRuns(a.run.id)).toEqual([]);
    expect(await bob.history.compare(a.run.id, b.run.id)).toBeNull();
    expect(await bob.history.compare(b.run.id, a.run.id)).toBeNull();
    // Nothing of Alice's was changed by the attempts above.
    expect((await base.projects.getById(a.project.id))!.name).toBe("alice");
    expect((await base.bugs.getDetail(a.bug.id))!.status).toBe("OPEN");
    expect(await base.reports.getBundle(a.bundle.id)).not.toBeNull();
    expect(await base.pages.getByIds(a.project.id, [a.page.id])).toHaveLength(1);
  });

  it("refuses to create child records under another owner's parent", async () => {
    const reject = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ResourceNotFoundError);
    await reject(bob.testRuns.createAndEnqueue({ projectId: a.project.id, configurationId: null, name: null, modules: ["links"], browsers: ["chromium"], viewports: [VIEWPORT], pageIds: [a.page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 1, navigationTimeoutMs: 1000 } }));
    await reject(bob.crawlRuns.createAndEnqueue(a.project.id, a.project.websiteUrl, DEFAULT_CRAWL_CONFIG));
    await reject(bob.pages.addManual(a.project.id, "https://alice.test/x", "https://alice.test/x"));
    await reject(bob.documents.create({ projectId: a.project.id, kind: "REFERENCE", fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "k", checksumSha256: "x" }));
    await reject(bob.testConfigurations.create({ ...a.config, projectId: a.project.id }));
    await reject(bob.reports.requestBundle(a.run.id));
    await reject(bob.bugs.createFromRun(a.run.id));
    await reject(bob.activity.record({ projectId: a.project.id, entityType: "x", entityId: null, action: "x", summary: "x" }));
    // Moving one's own configuration into another owner's project is refused too.
    expect(await bob.testConfigurations.update(b.config.id, { ...b.config, projectId: a.project.id })).toBeNull();
  });

  it("scopes every list, count and analytic to the owner", async () => {
    expect((await bob.testRuns.list()).map((r) => r.id).sort()).toEqual([b.run.id, b.externalRunId].sort());
    expect((await bob.pages.list()).every((p) => p.projectId === b.project.id)).toBe(true);
    expect(await bob.pages.count()).toBe(1);
    expect((await bob.testCases.list()).every((c) => c.projectId === b.project.id)).toBe(true);
    expect((await bob.bugs.list()).map((x) => x.id)).toEqual([b.bug.id]);
    expect(await bob.bugs.count()).toBe(1);
    expect((await bob.reports.listBundles()).map((x) => x.id)).toEqual([b.bundle.id]);
    expect(await bob.reports.countBundles()).toBe(1);
    expect((await bob.reports.list()).every((r) => r.projectId === b.project.id)).toBe(true);
    expect((await bob.history.listRuns()).map((r) => r.id).sort()).toEqual([b.run.id, b.externalRunId].sort());
    expect(await bob.externalTests.count()).toBe(1);
    expect((await bob.externalTests.list()).map((e) => e.runId)).toEqual([b.externalRunId]);
    expect(await bob.projects.count()).toBe(1);
    const metrics = await bob.dashboard.getMetrics();
    expect(metrics).toMatchObject({ totalProjects: 1, failed: 1, bugs: 1 });
    expect((await base.dashboard.getMetrics()).totalProjects).toBe(2);
    expect((await bob.dashboard.getResultTrend(30)).reduce((n, d) => n + d.failed, 0)).toBe(1);
    // Filtering by another owner's project id returns nothing rather than their data.
    expect(await bob.bugs.list({ projectId: a.project.id })).toEqual([]);
    expect(await bob.history.listRuns({ projectId: a.project.id })).toEqual([]);
    expect(await bob.bugs.facets(a.project.id)).toEqual({ pages: [], testTypes: [], browsers: [] });
  });

  it("never lets a client-supplied owner id override the trusted identity", async () => {
    const created = await bob.projects.create({ ...projectInput({ name: "mine" }), ownerId: "user-alice" } as never);
    expect(await base.ownership.ownerOf("project", created.id)).toBe("user-bob");
    expect((await bob.projects.list({ ownerId: "user-alice" } as never)).map((p) => p.name).sort()).toEqual(["bob", "mine"]);
    expect((await bob.bugs.list({ ownerId: "user-alice" })).map((x) => x.id)).toEqual([b.bug.id]);
    expect((await bob.history.listRuns({ ownerId: "user-alice" })).every((r) => r.projectId === b.project.id)).toBe(true);
    const entry = await bob.activity.record({ ownerId: "user-alice", projectId: null, entityType: "x", entityId: null, action: "x", summary: "bob note" });
    expect((await alice.activity.list()).map((x) => x.id)).not.toContain(entry.id);
    // The project-creation service also gets its owner from the scoped provider only.
    const res = await createProject({ db: bob, storage, maxUploadBytes: 1_000_000 }, { name: "Svc", websiteUrl: "https://svc.test/", ownerId: "user-alice" }, null);
    expect(res.ok && (await base.ownership.ownerOf("project", res.project.id))).toBe("user-bob");
  });

  it("resolves storage keys to their owner and rejects malformed or unknown keys", async () => {
    expect(await base.ownership.ownerOf("storageKey", a.screenshotKey)).toBe("user-alice");
    expect(await base.ownership.ownerOf("storageKey", `reports/${a.bundle.id}/x.pdf`)).toBe("user-alice");
    expect(await base.ownership.ownerOf("storageKey", `projects/${b.project.id}/documents/x`)).toBe("user-bob");
    for (const key of ["", "runs", "runs/", "../runs/x", "external-drafts/abc/source.xlsx", "unknown/x/y", `runs/does-not-exist/x.png`]) {
      expect(await base.ownership.ownerOf("storageKey", key)).toBeNull();
    }
    expect(await base.ownership.ownerOf("project", null as unknown as string)).toBeNull();
  });

  it("hides projects without an owner from every identity (fail closed)", async () => {
    const orphan = await base.projects.create(projectInput({ name: "orphan" }));
    expect(await base.ownership.ownerOf("project", orphan.id)).toBeNull();
    expect(await alice.projects.getById(orphan.id)).toBeNull();
    expect(await new OwnerScopedDatabaseProvider(base, LOCAL_OWNER_ID).projects.getById(orphan.id)).toBeNull();
    expect(() => new OwnerScopedDatabaseProvider(base, "")).toThrow();
    expect(() => new OwnerScopedDatabaseProvider(base, "   ")).toThrow();
  });

  it("deleting a project through the scoped provider removes only the owner's data", async () => {
    expect(await alice.projects.delete(a.project.id)).toBe(true);
    expect(await base.projects.getById(b.project.id)).not.toBeNull();
    expect(await bob.bugs.count()).toBe(1);
    expect(base.sqlite.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("trusted identity", () => {
  it("defaults to the local operator in development and test", () => {
    expect(resolveIdentity({ NODE_ENV: "development" })).toEqual({ ok: true, identity: { ownerId: LOCAL_OWNER_ID, source: "local" } });
    expect(resolveIdentity({ NODE_ENV: "test", AUTH_PROVIDER: "local" })).toMatchObject({ ok: true });
  });

  it("fails closed for production builds, Vercel, Supabase (not implemented yet) and invalid configuration", () => {
    expect(resolveIdentity({ NODE_ENV: "production" })).toEqual({ ok: false, reason: "LOCAL_MODE_NOT_ALLOWED" });
    for (const flag of ["1", "TRUE", "yes", " true"]) expect(resolveIdentity({ NODE_ENV: "production", QA_PILOT_LOCAL_MODE: flag })).toMatchObject({ ok: false });
    expect(resolveIdentity({ NODE_ENV: "production", QA_PILOT_LOCAL_MODE: "true" })).toMatchObject({ ok: true });
    expect(resolveIdentity({ NODE_ENV: "development", VERCEL: "1" })).toEqual({ ok: false, reason: "LOCAL_MODE_NOT_ALLOWED" });
    expect(resolveIdentity({ NODE_ENV: "production", VERCEL: "1", QA_PILOT_LOCAL_MODE: "true" })).toEqual({ ok: false, reason: "LOCAL_MODE_NOT_ALLOWED" });
    expect(resolveIdentity({ AUTH_PROVIDER: "supabase", NODE_ENV: "development" })).toEqual({ ok: false, reason: "AUTH_NOT_IMPLEMENTED" });
    for (const value of ["admin", "none", "LOCAL", "supabase-dev"]) expect(resolveIdentity({ AUTH_PROVIDER: value })).toMatchObject({ ok: false });
  });
});

describe("route handlers and server actions", () => {
  const env = { ...process.env };
  let dir: string;
  let ids: Awaited<ReturnType<typeof seedOwner>>;

  beforeAll(async () => {
    dir = makeTempDir();
    process.env.DATABASE_PATH = path.join(dir, "routes.db");
    process.env.STORAGE_PATH = path.join(dir, "storage");
    delete process.env.AUTH_PROVIDER;
    const { getDatabase } = await import("@/lib/database");
    const db = getDatabase() as LocalDatabaseProvider;
    // Data owned by someone other than the local operator: the local identity must get 404, not the data.
    ids = await seedOwner(db, new LocalStorageProvider(process.env.STORAGE_PATH), "user-someone-else", "other");
  });
  afterAll(() => {
    process.env = env;
  });

  const routes = async () => {
    const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
    const r = (url: string) => new Request(`http://localhost${url}`);
    return [
      ["artifacts", (await import("@/app/api/artifacts/route")).GET(r(`/api/artifacts?key=${encodeURIComponent(ids.screenshotKey)}`))],
      ["crawl-runs", (await import("@/app/api/crawl-runs/[id]/route")).GET(r("/x"), ctx({ id: ids.crawl.id }) as never)],
      ["documents", (await import("@/app/api/documents/[id]/route")).GET(r("/x"), ctx({ id: ids.document.id }) as never)],
      ["external download", (await import("@/app/api/external-test-cases/[id]/download/route")).GET(r("/x"), ctx({ id: ids.externalRunId }) as never)],
      ["external progress", (await import("@/app/api/external-test-cases/[id]/route")).GET(r("/x"), ctx({ id: ids.externalRunId }) as never)],
      ["reports", (await import("@/app/api/reports/[id]/[kind]/route")).GET(r("/x"), ctx({ id: ids.bundle.id, kind: "PDF" }) as never)],
      ["test-runs", (await import("@/app/api/test-runs/[id]/route")).GET(r("/x"), ctx({ id: ids.run.id }) as never)],
    ] as const;
  };

  it("returns 401 from every API route when there is no identity", async () => {
    process.env.AUTH_PROVIDER = "supabase";
    try {
      for (const [name, res] of await routes()) expect((await res).status, name).toBe(401);
      const workers = (await import("@/app/api/workers/route")).GET;
      await expect(workers()).rejects.toThrow(); // connection() needs a request scope; outside one it never reaches data
    } finally {
      delete process.env.AUTH_PROVIDER;
    }
  });

  it("returns 404 for resources of another owner when signed in", async () => {
    for (const [name, res] of await routes()) expect((await res).status, name).toBe(404);
  });

  it("server actions redirect when there is no identity, before touching data", async () => {
    process.env.AUTH_PROVIDER = "supabase";
    try {
      const { actionDb, actionIdentity, routeDb } = await import("@/lib/server/db");
      expect(() => actionDb()).toThrow(/NEXT_REDIRECT/);
      expect(() => actionIdentity()).toThrow(/NEXT_REDIRECT/);
      expect(routeDb().denied?.status).toBe(401);
    } finally {
      delete process.env.AUTH_PROVIDER;
    }
  });

  it("every app entry point goes through the authorized helpers", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.resolve("app"));
    walk(path.resolve("components"));
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, `${f} must not use the unscoped provider`).not.toMatch(/getDatabase\(|from "@\/lib\/database"/);
      if (f.endsWith(`${path.sep}route.ts`)) expect(src, `${f} must check access`).toMatch(/const access = routeDb\(\);\s+if \(access\.denied\) return access\.denied;/);
      if (/^"use server";/.test(src)) expect(src, `${f} must use actionDb`).toMatch(/actionDb\(\)/);
    }
  });
});

describe("migration 7 preserves existing data", () => {
  it("adds ownership without losing rows and assigns pre-existing data to the local operator", () => {
    const file = path.join(makeTempDir(), "v6.db");
    const db = openSqlite(file);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const m of MIGRATIONS.filter((x) => x.version <= 6)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
    }
    db.prepare("INSERT INTO projects (id, name, website_url, created_at, updated_at) VALUES ('p1', 'Legacy', 'https://legacy.test/', 'now', 'now')").run();
    db.prepare("INSERT INTO activity_log (id, project_id, entity_type, action, summary) VALUES ('a1', 'p1', 'project', 'created', 'x'), ('a2', NULL, 'project', 'deleted', 'y')").run();
    expect(runMigrations(db)).toBe(7);
    expect(db.prepare("SELECT id, name, owner_id FROM projects").all()).toEqual([{ id: "p1", name: "Legacy", owner_id: LOCAL_OWNER_ID }]);
    expect(db.prepare("SELECT id, owner_id FROM activity_log ORDER BY id").all()).toEqual([{ id: "a1", owner_id: LOCAL_OWNER_ID }, { id: "a2", owner_id: LOCAL_OWNER_ID }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(runMigrations(db)).toBe(7); // idempotent
    db.close();
    // The local operator still sees legacy data through the scoped provider.
    const provider = LocalDatabaseProvider.open(file);
    return new OwnerScopedDatabaseProvider(provider, LOCAL_OWNER_ID).projects.list().then((list) => {
      expect(list.map((p) => p.name)).toEqual(["Legacy"]);
      return provider.close();
    });
  });
});

describe("email allow-list preparation", () => {
  it("normalizes addresses consistently and rejects malformed input", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmail("ｊａｎｅ@example.com")).toBe("jane@example.com"); // NFKC full-width letters
    for (const bad of ["", "jane", "jane@", "@example.com", "a@b", "a b@example.com", "a@example.com,b@example.com", "<a@example.com>", null, 42]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  it("allows only listed addresses or domains and fails closed", () => {
    const list = parseAllowList(" Jane@Example.com, @qa.example.org\nnot-an-email, @bad, ");
    expect([...list.emails]).toEqual(["jane@example.com"]);
    expect([...list.domains]).toEqual(["qa.example.org"]);
    expect(isEmailAllowed("JANE@example.com", list)).toBe(true);
    expect(isEmailAllowed("tester@qa.example.org", list)).toBe(true);
    expect(isEmailAllowed("tester@sub.qa.example.org", list)).toBe(false);
    expect(isEmailAllowed("jane@example.com.evil.test", list)).toBe(false);
    expect(isEmailAllowed("other@example.com", list)).toBe(false);
    expect(isEmailAllowed("jane@example.com", parseAllowList(undefined))).toBe(false);
  });
});
