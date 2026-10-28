import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LocalActivityRepository,
  LocalDashboardRepository,
  LocalDocumentRepository,
  LocalTestConfigurationRepository,
  LocalTestRunRepository,
  type LocalDatabaseProvider,
} from "@/lib/database/local/local-database-provider";
import { LocalTestCaseRepository, LocalTestResultRepository, LocalWorkerRepository } from "@/lib/database/local/engine-repositories";
import { LocalHistoryRepository } from "@/lib/database/local/history-repository";
import { LocalOwnershipRepository } from "@/lib/database/local/ownership";
import type { SqlExecutor } from "@/lib/database/sql/executor";
import { DEFAULT_REPORT_SECTIONS } from "@/lib/constants/testing";
import type { TestConfigurationInput } from "@/types";
import { createTestDb } from "./helpers";
import { createPgTestDatabase, noRawConnection, sqliteSchema, type PgTestDatabase } from "./support/postgres";

/**
 * Compatibility of the repository methods already on SqlExecutor, on SQLite and on PostgreSQL (PGlite, in process;
 * schema translated from the SQLite one by tests/support/postgres.ts). Each scenario runs on a fresh SQLite database
 * and on a reset PostgreSQL database through the same repository classes; results must be identical. On PostgreSQL
 * the repositories get no SQLite connection at all, so any raw-connection use fails the test.
 *
 * Not covered here (still on the raw SQLite connection, so they cannot run on PostgreSQL yet): every method listed in
 * the Phase 3.1 inventory, including history `listRuns` (its row mapping), `createAndEnqueue` and `requestCancel`.
 */

const NOW = "2026-03-10T12:00:00.000Z";
const T = (day: number, hour = 10) => `2026-03-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

interface Backend {
  name: "sqlite" | "postgres";
  sql: SqlExecutor;
  documents: LocalDocumentRepository;
  testConfigurations: LocalTestConfigurationRepository;
  testRuns: LocalTestRunRepository;
  activity: LocalActivityRepository;
  dashboard: LocalDashboardRepository;
  ownership: LocalOwnershipRepository;
  testCases: LocalTestCaseRepository;
  workers: LocalWorkerRepository;
  testResults: LocalTestResultRepository;
  history: LocalHistoryRepository;
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

function sqliteBackend(db: LocalDatabaseProvider): Backend {
  // The provider's own wiring, as the app uses it.
  return { name: "sqlite", sql: db.sql, ...(db as unknown as Omit<Backend, "name" | "sql">) };
}
function postgresBackend(sql: SqlExecutor): Backend {
  return {
    name: "postgres",
    sql,
    documents: new LocalDocumentRepository(sql),
    testConfigurations: new LocalTestConfigurationRepository(sql),
    testRuns: new LocalTestRunRepository(noRawConnection, sql),
    activity: new LocalActivityRepository(sql),
    dashboard: new LocalDashboardRepository(sql),
    ownership: new LocalOwnershipRepository(sql),
    testCases: new LocalTestCaseRepository(sql),
    workers: new LocalWorkerRepository(sql),
    testResults: new LocalTestResultRepository(noRawConnection, sql),
    history: new LocalHistoryRepository(noRawConnection, sql),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Generated ids differ per backend; everything else must match. */
const comparable = (v: unknown) => JSON.parse(JSON.stringify(v ?? null, (_k, x) => (typeof x === "string" && UUID.test(x) ? "<uuid>" : x)));
const failure = (e: unknown) => ({ rejected: true, kind: e instanceof RangeError ? "RangeError" : "database error" });

/** Runs a scenario on a fresh SQLite database and on the reset PostgreSQL database; returns both results. */
async function onBoth<T>(scenario: (b: Backend) => Promise<T>): Promise<{ sqlite: unknown; postgres: unknown }> {
  await lite?.close();
  lite = createTestDb();
  await pg.reset();
  const run = async (b: Backend) => {
    try {
      return comparable(await scenario(b));
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Raw SQLite connection used")) throw e;
      return failure(e);
    }
  };
  return { sqlite: await run(sqliteBackend(lite)), postgres: await run(postgresBackend(pg.sql)) };
}
async function same<T>(scenario: (b: Backend) => Promise<T>) {
  const r = await onBoth(scenario);
  expect(r.postgres).toEqual(r.sqlite);
  return r.sqlite as T;
}

const exec = (b: Backend, sql: string, params: (string | number | null)[] = []) => b.sql.run(sql, params);

/** Mixed data from two owners and a legacy project without owner, written with portable SQL on either backend. */
async function seed(b: Backend) {
  for (const [id, owner, name, url] of [
    ["p-a1", "user-alice", "Alpha", "https://alpha.test/"],
    ["p-a2", "user-alice", "Beta_Blog", "https://beta.test/"],
    ["p-b", "user-bob", "Gamma", "https://gamma.test/"],
    ["p-l", null, "Legacy", "https://legacy.test/"],
  ]) {
    await exec(b, "INSERT INTO projects (id, name, website_url, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [id, name, url, owner, T(1), T(1)]);
  }
  await exec(b, "INSERT INTO pages (id, project_id, url, normalized_url) VALUES ('pg-a1', 'p-a1', 'https://alpha.test/', 'https://alpha.test/')");
  await exec(b, "INSERT INTO pages (id, project_id, url, normalized_url) VALUES ('pg-b', 'p-b', 'https://gamma.test/', 'https://gamma.test/')");
  const runs: [string, string, string, string | null, string, string | null][] = [
    ["r1", "p-a1", "COMPLETED", "Release 1", T(1), T(1, 11)],
    ["r2", "p-a1", "COMPLETED", "release 2", T(2), T(2, 11)],
    ["r3", "p-a1", "RUNNING", null, T(2), null], // same created_at as r2, inserted later
    ["r4", "p-a2", "FAILED", "Nightly", T(3), T(3, 11)],
    ["rb1", "p-b", "COMPLETED", "Bob run", T(1), T(1, 11)],
    ["rb2", "p-b", "COMPLETED", "Bob run 2", T(2), T(2, 11)],
    ["rl1", "p-l", "COMPLETED", "Legacy run", T(1), T(1, 11)],
  ];
  for (const [id, project, status, name, created, completed] of runs) {
    await exec(b, "INSERT INTO test_runs (id, project_id, status, name, created_at, completed_at, config_snapshot, options, progress_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      project,
      status,
      name,
      created,
      completed,
      JSON.stringify({ modules: ["links"], browsers: ["chromium"], viewports: ["desktop"], pageIds: ["pg-a1"] }),
      JSON.stringify({ allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 }),
      2,
    ]);
  }
  await exec(b, "INSERT INTO test_run_pages (id, test_run_id, page_id, status) VALUES ('trp-1', 'r1', 'pg-a1', 'COMPLETED'), ('trp-2', 'r2', 'pg-a1', 'COMPLETED'), ('trp-3', 'rb1', 'pg-b', 'FAILED')");
  let n = 0;
  const result = async (run: string, project: string, title: string, status: string, opts: { page?: string; code?: string | null; created?: string; executed?: string } = {}) => {
    const c = `c-${++n}`;
    await exec(b, "INSERT INTO test_cases (id, project_id, test_run_id, page_id, module, title, code, created_at) VALUES (?, ?, ?, ?, 'links', ?, ?, ?)", [c, project, run, opts.page ?? null, title, opts.code ?? null, opts.created ?? T(1)]);
    const verdict = ["PASS", "FAIL", "WARNING"].includes(status);
    await exec(b, "INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at) VALUES (?, ?, ?, ?, ?)", [`res-${n}`, run, c, status, verdict ? (opts.executed ?? T(8)) : null]);
    return c;
  };
  await result("r1", "p-a1", "home", "PASS", { page: "pg-a1", code: "TC-2" });
  await result("r1", "p-a1", "about", "PASS", { code: "TC-1" });
  await result("r1", "p-a1", "contact", "FAIL", { code: null });
  await result("r2", "p-a1", "home", "FAIL", { page: "pg-a1", code: "TC-2", created: T(2), executed: T(9) });
  await result("r2", "p-a1", "about", "FAIL", { code: null, created: T(2), executed: T(10) });
  await result("r2", "p-a1", "contact", "WARNING", { code: "TC-3", created: T(2), executed: T(10) });
  await result("r2", "p-a1", "extra", "NOT EXECUTED", { created: T(2) });
  await result("r2", "p-a1", "na", "NOT APPLICABLE", { created: T(2) });
  const multi = await result("rb1", "p-b", "x", "PASS", { page: "pg-b" });
  await exec(b, "INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at) VALUES ('res-extra-1', 'rb1', ?, 'FAIL', ?), ('res-extra-2', 'rb1', ?, 'PASS', ?)", [multi, T(9), multi, T(9)]);
  await result("rb2", "p-b", "x", "FAIL", { page: "pg-b", created: T(2), executed: T(10) });
  await result("rl1", "p-l", "legacy", "PASS");
  for (const [id, project, severity, status] of [
    ["bug-1", "p-a1", "HIGH", "OPEN"],
    ["bug-2", "p-a1", "CRITICAL", "IN_PROGRESS"],
    ["bug-3", "p-b", "LOW", "CLOSED"],
    ["bug-4", "p-l", "MEDIUM", "OPEN"],
  ]) {
    await exec(b, "INSERT INTO bugs (id, project_id, title, severity, status) VALUES (?, ?, 'bug', ?, ?)", [id, project, severity, status]);
  }
  await exec(b, "INSERT INTO screenshots (id, test_run_id, storage_key, captured_at) VALUES ('shot-1', 'r1', 'runs/r1/pg-a1/chromium-desktop/01.png', ?)", [T(1)]);
  await exec(b, "INSERT INTO report_bundles (id, project_id, name, website) VALUES ('rep-1', 'p-b', 'Bundle', 'https://gamma.test/')");
  await exec(b, "INSERT INTO crawl_runs (id, project_id, start_url) VALUES ('crawl-1', 'p-a2', 'https://beta.test/')");
  await exec(b, "INSERT INTO worker_heartbeats (worker_id, hostname, pid, handlers, started_at, last_seen_at) VALUES ('w-old', 'h', 1, '[\"crawl.execute\"]', ?, ?), ('w-new', 'h', 2, '[\"run.execute\"]', ?, ?)", [T(1), "2026-03-10T11:59:50.000Z", T(1), "2026-03-10T11:59:55.000Z"]);
}

describe("PostgreSQL compatibility: schema", () => {
  it("creates the same tables, columns and indexes", async () => {
    const lite = sqliteSchema();
    const tables = (await pg.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
    expect(tables.sort()).toEqual(lite.filter((s) => s.type === "table").map((s) => s.name).sort());
    const indexes = (await pg.db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).rows.map((r) => r.indexname);
    for (const s of lite.filter((s) => s.type === "index")) expect(indexes, s.name).toContain(s.name);
    const db = createTestDb();
    try {
      for (const t of ["projects", "test_runs", "test_cases", "test_results", "documents", "jobs"]) {
        const liteCols = (db.sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name).sort();
        const pgCols = (await pg.db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [t])).rows.map((r) => r.column_name).filter((c) => c !== "rowid");
        expect(pgCols.sort(), t).toEqual(liteCols);
      }
    } finally {
      await db.close();
    }
  });

  it("applies the same defaults, in the same ISO-8601 text format", async () => {
    const r = await onBoth(async (b) => {
      await exec(b, "INSERT INTO projects (id, name, website_url) VALUES ('p', 'P', 'https://p.test/')");
      const row = (await b.sql.get<Record<string, unknown>>("SELECT created_at, updated_at, owner_id FROM projects WHERE id = 'p'"))!;
      await exec(b, "INSERT INTO test_runs (id, project_id) VALUES ('r', 'p')");
      const run = (await b.sql.get<Record<string, unknown>>("SELECT status, config_snapshot, cancel_requested, run_type FROM test_runs WHERE id = 'r'"))!;
      return { createdFormat: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(String(row.created_at)), sameStamp: row.created_at === row.updated_at, owner: row.owner_id, run };
    });
    expect(r.postgres).toEqual(r.sqlite);
    expect(r.sqlite).toEqual({ createdFormat: true, sameStamp: true, owner: null, run: { status: "PENDING", config_snapshot: "{}", cancel_requested: 0, run_type: "WEBSITE" } });
  });

  it("enforces the same constraints (CHECK, NOT NULL, UNIQUE, FOREIGN KEY) and cascades", async () => {
    const violations = [
      "INSERT INTO projects (id, name, website_url) VALUES ('x', '   ', 'https://x.test/')",
      "INSERT INTO test_runs (id, project_id, status) VALUES ('x', 'p', 'BOGUS')",
      "INSERT INTO test_results (id, test_run_id, test_case_id, status) VALUES ('x', 'r', 'c', 'PASS')", // verdict needs executed_at
      "INSERT INTO bugs (id, project_id, title, severity) VALUES ('x', 'p', 't', 'URGENT')",
      "INSERT INTO documents (id, project_id, kind, file_name, mime_type, size_bytes, storage_key, checksum_sha256) VALUES ('x', 'p', 'REFERENCE', 'f', 'm', -1, 'k2', 's')",
      "INSERT INTO documents (id, project_id, kind, file_name, mime_type, size_bytes, storage_key, checksum_sha256) VALUES ('x', 'p', 'REFERENCE', 'f', 'm', 1, 'k', 's')", // duplicate storage_key
      "INSERT INTO documents (id, project_id, kind, file_name, mime_type, size_bytes, storage_key, checksum_sha256) VALUES ('x', 'missing', 'REFERENCE', 'f', 'm', 1, 'k3', 's')",
      "INSERT INTO pages (id, project_id, url) VALUES ('x', 'p', 'u')", // NOT NULL normalized_url
    ];
    const outcome = await same(async (b) => {
      await exec(b, "INSERT INTO projects (id, name, website_url) VALUES ('p', 'P', 'https://p.test/')");
      await exec(b, "INSERT INTO test_runs (id, project_id) VALUES ('r', 'p')");
      await exec(b, "INSERT INTO test_cases (id, project_id, test_run_id, module, title) VALUES ('c', 'p', 'r', 'links', 't')");
      await exec(b, "INSERT INTO documents (id, project_id, kind, file_name, mime_type, size_bytes, storage_key, checksum_sha256) VALUES ('d', 'p', 'REFERENCE', 'f', 'm', 1, 'k', 's')");
      const rejected: boolean[] = [];
      for (const v of violations) rejected.push(await exec(b, v).then(() => false, () => true));
      await exec(b, "DELETE FROM projects WHERE id = 'p'");
      const left = await b.sql.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM documents) + (SELECT COUNT(*) FROM test_runs) + (SELECT COUNT(*) FROM test_cases) AS n");
      return { rejected, left: Number(left!.n) };
    });
    expect(outcome).toEqual({ rejected: violations.map(() => true), left: 0 });
  });
});

describe("PostgreSQL compatibility: executor basics", () => {
  it("binds placeholders but not question marks inside literals, and returns the same values", async () => {
    const row = await same((b) => b.sql.get("SELECT ? AS a, '?' AS b, 'it''s ?' AS c, ? AS d, ? AS e", ["x", null, "y?"]));
    expect(row).toEqual({ a: "x", b: "?", c: "it's ?", d: null, e: "y?" });
  });

  it("reports changed rows the same way, including zero", async () => {
    const changes = await same(async (b) => {
      await seed(b);
      return [
        (await exec(b, "UPDATE bugs SET status = 'OPEN' WHERE project_id = ?", ["p-a1"])).changes,
        (await exec(b, "UPDATE bugs SET status = 'OPEN' WHERE project_id = ?", ["none"])).changes,
        (await exec(b, "DELETE FROM worker_heartbeats")).changes,
      ];
    });
    expect(changes).toEqual([2, 0, 2]);
  });

  it("returns counts as values the repositories turn into the same numbers", async () => {
    const r = await onBoth(async (b) => Number((await b.sql.get<{ c: unknown }>("SELECT COUNT(*) AS c FROM projects"))!.c));
    expect(r).toEqual({ sqlite: 0, postgres: 0 });
  });
});

describe("PostgreSQL compatibility: transactions", () => {
  const enqueue = async (tx: SqlExecutor, runId: string) => {
    await tx.run("INSERT INTO test_runs (id, project_id, status) VALUES (?, 'p', 'PENDING')", [runId]);
    await tx.run("INSERT INTO jobs (id, type, payload, status) VALUES (?, 'run.execute', ?, 'PENDING')", [`job-${runId}`, JSON.stringify({ testRunId: runId })]);
  };
  const counts = async (b: Backend) => ({
    runs: Number((await b.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM test_runs"))!.c),
    jobs: Number((await b.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM jobs"))!.c),
  });

  it("commits a run and its job together, and rolls both back on failure", async () => {
    const r = await same(async (b) => {
      await exec(b, "INSERT INTO projects (id, name, website_url) VALUES ('p', 'P', 'https://p.test/')");
      await b.sql.transaction((tx) => enqueue(tx, "ok"));
      const afterCommit = await counts(b);
      const error = await b.sql
        .transaction(async (tx) => {
          await enqueue(tx, "fails");
          throw new Error("worker unavailable");
        })
        .then(() => null, (e: Error) => e.message);
      return { afterCommit, error, afterRollback: await counts(b) };
    });
    expect(r).toEqual({ afterCommit: { runs: 1, jobs: 1 }, error: "worker unavailable", afterRollback: { runs: 1, jobs: 1 } });
  });

  it("rolls back everything when a statement violates a constraint part-way", async () => {
    const r = await same(async (b) => {
      await exec(b, "INSERT INTO projects (id, name, website_url) VALUES ('p', 'P', 'https://p.test/')");
      const rejected = await b.sql
        .transaction(async (tx) => {
          await enqueue(tx, "a");
          await tx.run("INSERT INTO test_runs (id, project_id, status) VALUES ('b', 'p', 'BOGUS')");
        })
        .then(() => false, () => true);
      return { rejected, ...(await counts(b)) };
    });
    expect(r).toEqual({ rejected: true, runs: 0, jobs: 0 });
  });

  it("rolls back only a failed nested transaction (savepoint)", async () => {
    const r = await same(async (b) => {
      await exec(b, "INSERT INTO projects (id, name, website_url) VALUES ('p', 'P', 'https://p.test/')");
      await b.sql.transaction(async (tx) => {
        await enqueue(tx, "outer");
        await tx.transaction((inner) => enqueue(inner, "kept"));
        await tx.transaction(async (inner) => {
          await enqueue(inner, "undone");
          throw new Error("inner");
        }).catch(() => undefined);
      });
      return (await b.sql.all<{ id: string }>("SELECT id FROM test_runs ORDER BY id")).map((x) => x.id);
    });
    expect(r).toEqual(["kept", "outer"]);
  });

  it("does not let concurrent transactions see each other's uncommitted rows", async () => {
    const r = await same(async (b) => {
      await exec(b, "INSERT INTO projects (id, name, website_url) VALUES ('p', 'P', 'https://p.test/')");
      const results = await Promise.all([1, 2, 3].map((i) => b.sql.transaction(async (tx) => {
        const before = Number((await tx.get<{ c: number }>("SELECT COUNT(*) AS c FROM test_runs"))!.c);
        await enqueue(tx, `run-${i}`);
        return before;
      })));
      return { before: results.sort(), ...(await counts(b)) };
    });
    // Both backends run these one after another (SQLite: per connection; PGlite: a single connection).
    expect(r).toEqual({ before: [0, 1, 2], runs: 3, jobs: 3 });
  });
});

describe("PostgreSQL compatibility: repositories on SqlExecutor", () => {
  it("returns empty results from every repository on empty tables", async () => {
    const r = await same(async (b) => ({
      docs: await b.documents.listByProject("p"),
      configs: await b.testConfigurations.listByProject("p"),
      runs: await b.testRuns.list(),
      run: await b.testRuns.getDetail("r"),
      counts: await b.testRuns.countsByRun(["r"]),
      activity: await b.activity.list(),
      metrics: await b.dashboard.getMetrics("user-alice"),
      trend: await b.dashboard.getResultTrend(30),
      regressions: await b.dashboard.getRegressions(),
      cases: await b.testCases.list(),
      worker: await b.workers.status(),
      artifact: await b.testResults.isKnownArtifact("runs/r/x.png"),
      history: await b.history.countRuns({ search: "x" }),
      comparable: await b.history.comparableRuns("r"),
      owner: await b.ownership.ownerOf("project", "p"),
    }));
    expect(r).toMatchObject({ docs: [], runs: [], run: null, regressions: [], cases: [], worker: { online: false }, artifact: false, history: 0, owner: null });
  });

  it("documents: create, list (insertion order breaks ties), get, delete", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const r = await same(async (b) => {
      await seed(b);
      const input = (i: number) => ({ projectId: "p-a1", kind: "REFERENCE" as const, fileName: `f${i}.pdf`, mimeType: "application/pdf", sizeBytes: 100 * i, storageKey: `projects/p-a1/f${i}`, checksumSha256: `sum${i}` });
      const a = await b.documents.create(input(1));
      await b.documents.create(input(2)); // same timestamp: newer first
      const dup = await b.documents.create(input(1)).then(() => "created", () => "rejected");
      return { a, list: (await b.documents.listByProject("p-a1")).map((d) => d.fileName), get: await b.documents.getById(a.id), dup, deleted: await b.documents.delete(a.id), again: await b.documents.delete(a.id) };
    });
    expect(r).toMatchObject({ list: ["f2.pdf", "f1.pdf"], dup: "rejected", deleted: true, again: false });
  });

  it("test configurations: create, update, list order, delete", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const r = await same(async (b) => {
      await seed(b);
      const input = (name: string): TestConfigurationInput => ({ projectId: "p-a1", name, scope: "SELECTED_PAGES", selectedPageIds: ["pg-a1"], manualUrls: [], modules: ["links"], browsers: ["chromium"], viewports: ["desktop-1440x900"], reportFormats: ["EXCEL"], reportSections: DEFAULT_REPORT_SECTIONS });
      const a = await b.testConfigurations.create(input("A"));
      await b.testConfigurations.create(input("B"));
      const updated = await b.testConfigurations.update(a.id, input("A2"));
      const missing = await b.testConfigurations.update("missing", input("X"));
      return { list: (await b.testConfigurations.listByProject("p-a1")).map((c) => c.name), updated, missing, deleted: await b.testConfigurations.delete(a.id) };
    });
    expect(r).toMatchObject({ list: ["B", "A2"], missing: null, deleted: true });
  });

  it("activity: records with the project's owner, lists per owner newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const r = await same(async (b) => {
      await seed(b);
      await b.activity.record({ projectId: "p-a1", entityType: "project", entityId: "p-a1", action: "a", summary: "first" });
      await b.activity.record({ projectId: "p-b", entityType: "project", entityId: "p-b", action: "b", summary: "bob" });
      await b.activity.record({ projectId: null, entityType: "system", entityId: null, action: "c", summary: "explicit owner", ownerId: "user-alice" });
      return {
        alice: (await b.activity.list({ ownerId: "user-alice" })).map((a) => a.summary),
        bob: (await b.activity.list({ ownerId: "user-bob" })).map((a) => a.summary),
        project: (await b.activity.list({ projectId: "p-a1" })).map((a) => [a.summary, a.projectName]),
        none: await b.activity.list({ ownerId: "" }),
      };
    });
    expect(r).toEqual({ alice: ["explicit owner", "first"], bob: ["bob"], project: [["first", "Alpha"]], none: [] });
  });

  it("ownership: same owner for every resource type, null for missing or unowned", async () => {
    const r = await same(async (b) => {
      await seed(b);
      const own = (res: Parameters<LocalOwnershipRepository["ownerOf"]>[0], id: string) => b.ownership.ownerOf(res, id);
      return [
        await own("project", "p-a1"),
        await own("project", "p-l"),
        await own("testRun", "rb1"),
        await own("crawlRun", "crawl-1"),
        await own("bug", "bug-3"),
        await own("reportBundle", "rep-1"),
        await own("storageKey", "runs/r1/pg-a1/x.png"),
        await own("storageKey", "reports/rep-1/file.pdf"),
        await own("storageKey", "projects/p-b/doc.pdf"),
        await own("storageKey", "elsewhere/x"),
        await own("testRun", "missing"),
      ];
    });
    expect(r).toEqual(["user-alice", null, "user-bob", "user-alice", "user-bob", "user-bob", "user-alice", "user-bob", "user-bob", null, null]);
  });

  it("dashboard metrics: same counts for everyone, each owner, and unknown owners", async () => {
    const r = await same(async (b) => {
      await seed(b);
      return { all: await b.dashboard.getMetrics(), alice: await b.dashboard.getMetrics("user-alice"), bob: await b.dashboard.getMetrics("user-bob"), nobody: await b.dashboard.getMetrics("") };
    });
    expect(r).toMatchObject({ alice: { totalProjects: 2, totalTestRuns: 4, passed: 2, failed: 3, openBugs: 2 }, bob: { totalProjects: 1, failed: 2 }, nobody: { totalProjects: 0 } });
  });

  it("dashboard result trend: same daily counts, UTC day grouping and window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const r = await same(async (b) => {
      await seed(b);
      return { all: await b.dashboard.getResultTrend(7), bob: await b.dashboard.getResultTrend(7, "user-bob"), short: await b.dashboard.getResultTrend(1) };
    });
    expect(r).toEqual({
      all: [
        { day: "2026-03-08", passed: 4, failed: 1, warnings: 0 },
        { day: "2026-03-09", passed: 1, failed: 2, warnings: 0 },
        { day: "2026-03-10", passed: 0, failed: 2, warnings: 1 },
      ],
      bob: [
        { day: "2026-03-08", passed: 1, failed: 0, warnings: 0 },
        { day: "2026-03-09", passed: 1, failed: 1, warnings: 0 },
        { day: "2026-03-10", passed: 0, failed: 1, warnings: 0 },
      ],
      short: [{ day: "2026-03-10", passed: 0, failed: 2, warnings: 1 }], // the window starts at 2026-03-09T12:00Z
    });
  });

  it("dashboard regressions: same latest/previous run selection (insertion order breaks ties) and matches", async () => {
    const r = await same(async (b) => {
      await seed(b);
      const rows = async (owner?: string) => (await b.dashboard.getRegressions(50, owner)).map((x) => `${x.projectId}:${x.testCaseTitle}:${x.previousRunId}->${x.latestRunId}`).sort();
      return { all: await rows(), alice: await rows("user-alice"), bob: await rows("user-bob") };
    });
    expect(r).toEqual({ all: ["p-a1:about:r1->r2", "p-a1:home:r1->r2", "p-b:x:rb1->rb2"], alice: ["p-a1:about:r1->r2", "p-a1:home:r1->r2"], bob: ["p-b:x:rb1->rb2"] });
  });

  it("test runs: list order (insertion order breaks ties), detail, counts", async () => {
    const r = await same(async (b) => {
      await seed(b);
      return {
        all: (await b.testRuns.list()).map((x) => x.id),
        alice: (await b.testRuns.list({ ownerId: "user-alice" })).map((x) => x.id),
        project: (await b.testRuns.list({ projectId: "p-b", limit: 1 })).map((x) => x.id),
        detail: await b.testRuns.getDetail("r2"),
        get: await b.testRuns.getById("rb1"),
        counts: await b.testRuns.countsByRun(["r2", "missing", "r2"]),
      };
    });
    expect(r).toMatchObject({ all: ["r4", "rb2", "r3", "r2", "rl1", "rb1", "r1"], alice: ["r4", "r3", "r2", "r1"], project: ["rb2"], detail: { cancelRequested: false, progressTotal: 2, modules: ["links"] } });
  });

  it("test cases: result summary JSON, NULL codes first, owner filter", async () => {
    const r = await same(async (b) => {
      await seed(b);
      const cases = await b.testCases.list({ projectId: "p-a1" });
      return {
        order: cases.map((c) => `${c.testRunId}:${c.code ?? "null"}`),
        summary: (await b.testCases.list({ projectId: "p-b" })).map((c) => c.resultSummary),
        bob: (await b.testCases.list({ ownerId: "user-bob" })).length,
        none: (await b.testCases.list({ ownerId: "" })).length,
      };
    });
    expect(r).toEqual({
      order: ["r2:null", "r2:null", "r2:null", "r2:TC-2", "r2:TC-3", "r1:null", "r1:TC-1", "r1:TC-2"],
      summary: [[{ status: "FAIL", count: 1 }], [{ status: "FAIL", count: 1 }, { status: "PASS", count: 2 }]],
      bob: 2,
      none: 0,
    });
  });

  it("worker status and artifact lookup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const r = await same(async (b) => {
      await seed(b);
      return { worker: await b.workers.status(), known: await b.testResults.isKnownArtifact("runs/r1/pg-a1/chromium-desktop/01.png"), unknown: await b.testResults.isKnownArtifact("runs/r1/x.png") };
    });
    expect(r).toEqual({ worker: { online: true, lastSeenAt: "2026-03-10T11:59:55.000Z", handlers: ["run.execute"] }, known: true, unknown: false });
  });

  it("history: run counts with filters (search is case-insensitive) and comparable runs", async () => {
    const r = await same(async (b) => {
      await seed(b);
      return {
        all: await b.history.countRuns(),
        release: await b.history.countRuns({ search: "RELEASE" }),
        escaped: await b.history.countRuns({ search: "_" }),
        alice: await b.history.countRuns({ ownerId: "user-alice", status: "COMPLETED" }),
        comparable: (await b.history.comparableRuns("r2")).map((x) => x.id),
      };
    });
    expect(r).toEqual({ all: 7, release: 2, escaped: 1, alice: 2, comparable: ["r1"] }); // same project, finished, not itself
  });
});
