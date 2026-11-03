import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalActivityRepository, LocalDocumentRepository, LocalTestRunRepository, type LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { applyMigrations, checksum, loadMigrations, migrationStatus, MigrationError, type Migration } from "@/lib/database/postgres/migrator";
import { importSqliteIntoPostgres, preflightSqlite, sqliteTables, validateImport } from "@/lib/database/postgres/sqlite-import";
import { createTestDb, projectInput } from "./helpers";
import { createPgTestDatabase, sqliteSchema, type PgTestDatabase } from "./support/postgres";

/**
 * Versioned PostgreSQL schema (lib/database/postgres/migrations), its migrator, and the SQLite → PostgreSQL data
 * import, in a disposable in-process PostgreSQL (PGlite). No hosted database is involved.
 */

/** Tables whose queries break ties by insertion order (SQLite rowid); PostgreSQL keeps an identity column for them. */
const ROWID_TABLES = ["activity_log", "bug_evidence", "bug_occurrences", "bug_status_history", "bugs", "crawl_runs", "documents", "external_test_executions", "jobs", "projects", "report_bundles", "reports", "test_configurations", "test_results", "test_runs"];

const open: PgTestDatabase[] = [];
const sqlites: LocalDatabaseProvider[] = [];
async function pgDb(migrations?: Migration[]) {
  const db = await createPgTestDatabase(migrations);
  open.push(db);
  return db;
}
function liteDb() {
  const db = createTestDb();
  sqlites.push(db);
  return db;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const db of open.splice(0)) await db.close();
  for (const db of sqlites.splice(0)) await db.close();
});

const fake = (version: number, name: string, sql: string): Migration => ({ version, name, sql, checksum: checksum(sql) });

describe("migration files", () => {
  it("are numbered 1..n and checksummed independently of line endings", () => {
    const migrations = loadMigrations();
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_, i) => i + 1));
    expect(migrations[0]).toMatchObject({ version: 1, name: "initial_schema" });
    // The checkout may already use CRLF (Windows); compare both line-ending forms with the recorded checksum.
    expect(checksum(migrations[0].sql.replace(/\r?\n/g, "\r\n"))).toBe(migrations[0].checksum);
    expect(checksum(migrations[0].sql.replace(/\r\n/g, "\n"))).toBe(migrations[0].checksum);
    const code = migrations[0].sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"); // ignore explanatory comments
    expect(code).not.toMatch(/strftime|COLLATE NOCASE|\bREAL\b|AUTOINCREMENT/i);
  });
});

describe("migrator", () => {
  it("applies pending migrations once, records them, and is a no-op afterwards", async () => {
    const pg = await pgDb([]);
    expect(await migrationStatus(pg.conn)).toMatchObject({ applied: [], pending: [{ version: 1, name: "initial_schema" }] });
    expect(await applyMigrations(pg.conn)).toEqual([1]);
    expect(await applyMigrations(pg.conn)).toEqual([]);
    const status = await migrationStatus(pg.conn);
    expect(status.pending).toEqual([]);
    expect(status.applied).toMatchObject([{ version: 1, name: "initial_schema", checksum: loadMigrations()[0].checksum }]);
  }, 30_000); // several PGlite databases; slow when the browser integration tests share the CPU

  it("rolls back a failing migration completely, keeps earlier ones, and stops", async () => {
    const pg = await pgDb([]);
    const [initial] = loadMigrations();
    const migrations = [initial, fake(2, "add_table", "CREATE TABLE extra_ok (id TEXT PRIMARY KEY);"), fake(3, "broken", "CREATE TABLE extra_partial (id TEXT); SELECT no_such_function();"), fake(4, "later", "CREATE TABLE extra_later (id TEXT);")];
    await expect(applyMigrations(pg.conn, migrations)).rejects.toThrow(/Migration 3 \(broken\) failed and was rolled back/);
    const exists = async (t: string) => (await pg.db.query<{ r: string | null }>("SELECT to_regclass($1) AS r", [t])).rows[0].r !== null;
    expect(await exists("extra_ok")).toBe(true);
    expect(await exists("extra_partial")).toBe(false); // the failed migration left nothing behind
    expect(await exists("extra_later")).toBe(false); // nothing after a failure runs
    expect((await migrationStatus(pg.conn, migrations)).pending.map((m) => m.version)).toEqual([3, 4]);
  });

  it("refuses to run when an applied migration was edited or the database is ahead of the code", async () => {
    const pg = await pgDb([]);
    const [initial] = loadMigrations();
    await applyMigrations(pg.conn, [initial]);
    const edited = { ...initial, sql: initial.sql + "\n-- edited", checksum: checksum(initial.sql + "\n-- edited") };
    await expect(applyMigrations(pg.conn, [edited, fake(2, "next", "CREATE TABLE never (id TEXT);")])).rejects.toThrow(/changed after it was applied/);
    expect((await pg.db.query("SELECT to_regclass('never') AS r")).rows[0]).toEqual({ r: null });
    await pg.db.query("INSERT INTO qa_pilot_migrations (version, name, checksum, applied_at) VALUES (9, 'future', 'x', 'now')");
    await expect(migrationStatus(pg.conn, [initial])).rejects.toThrow(MigrationError);
    await expect(applyMigrations(pg.conn, [initial])).rejects.toThrow(/migration 9 \(future\), which this code does not have/);
  });

  it("skips a migration another runner recorded meanwhile (re-checked under the lock)", async () => {
    // PGlite has a single connection, so two real concurrent runners cannot be simulated; this checks the re-check
    // that makes them safe: a version recorded after this runner read its status is not applied again.
    const pg = await pgDb([]);
    const [initial] = loadMigrations();
    const second = fake(2, "second", "CREATE TABLE second_table (id TEXT);");
    await applyMigrations(pg.conn, [initial]);
    const query = pg.conn.query.bind(pg.conn);
    let injected = false;
    const racing = {
      query: async (text: string, values?: unknown[]) => {
        if (!injected && text.startsWith("SELECT 1 FROM qa_pilot_migrations WHERE version")) {
          injected = true; // the "other runner" applies migration 2 just before this one looks
          await query("CREATE TABLE second_table (id TEXT)");
          await query("INSERT INTO qa_pilot_migrations (version, name, checksum, applied_at) VALUES (2, 'second', $1, 'other runner')", [second.checksum]);
        }
        return query(text, values);
      },
    };
    expect(await applyMigrations(racing, [initial, second])).toEqual([]);
    expect((await pg.db.query<{ applied_at: string }>("SELECT version, applied_at FROM qa_pilot_migrations ORDER BY version")).rows.map((r) => r.applied_at === "other runner")).toEqual([false, true]);
  });
});

describe("schema coverage (PostgreSQL migration vs the SQLite schema)", () => {
  it("has every SQLite table with the same columns, and rowid exactly where queries need it", async () => {
    const pg = await pgDb();
    const lite = liteDb();
    const liteTables = sqliteTables(lite.sqlite);
    expect(liteTables).toHaveLength(34);
    expect([...pg.tables].sort()).toEqual([...liteTables].sort());
    for (const t of liteTables) {
      const liteCols = (lite.sqlite.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name).sort();
      const pgCols = (await pg.db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [t])).rows.map((r) => r.column_name);
      expect(pgCols.filter((c) => c !== "rowid").sort(), t).toEqual(liteCols);
      expect(pgCols.includes("rowid"), `${t} rowid`).toBe(ROWID_TABLES.includes(t));
    }
  });

  it("has every index, unique constraint, foreign key and CHECK constraint", async () => {
    const pg = await pgDb();
    const lite = liteDb();
    const indexes = new Set((await pg.db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).rows.map((r) => r.indexname));
    for (const s of sqliteSchema().filter((s) => s.type === "index")) expect(indexes.has(s.name), s.name).toBe(true);
    const constraints = async (t: string, type: string) => Number((await pg.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conrelid = $1::regclass AND contype = $2", [`"${t}"`, type])).rows[0].n);
    for (const t of sqliteTables(lite.sqlite)) {
      const fks = lite.sqlite.prepare(`PRAGMA foreign_key_list("${t}")`).all() as { id: number; table: string; on_delete: string }[];
      expect(await constraints(t, "f"), `${t} foreign keys`).toBe(new Set(fks.map((f) => f.id)).size);
      const pgFks = (await pg.db.query<{ target: string; action: string }>("SELECT confrelid::regclass::text AS target, confdeltype AS action FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'", [`"${t}"`])).rows;
      const action = { CASCADE: "c", "SET NULL": "n", "NO ACTION": "a", RESTRICT: "r" } as Record<string, string>;
      expect(pgFks.map((f) => `${f.target}:${f.action}`).sort(), `${t} foreign key targets`).toEqual(fks.map((f) => `${f.table}:${action[f.on_delete]}`).sort());
      const sql = (lite.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) as { sql: string }).sql;
      expect(await constraints(t, "c"), `${t} checks`).toBe((sql.match(/CHECK\s*\(/g) ?? []).length);
      const liteUnique = (lite.sqlite.prepare(`PRAGMA index_list("${t}")`).all() as { unique: number; origin: string }[]).filter((i) => i.unique && i.origin === "u").length;
      expect(await constraints(t, "u"), `${t} unique`).toBe(liteUnique);
    }
  });

  it("enables row level security on every table, so other roles see nothing", async () => {
    const pg = await pgDb();
    const noRls = (await pg.db.query<{ relname: string }>("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity")).rows;
    expect(noRls).toEqual([]);
    await pg.db.query("INSERT INTO projects (id, name, website_url, owner_id) VALUES ('p', 'P', 'https://p.test/', 'user-alice')");
    await pg.db.exec("CREATE ROLE api_user; GRANT USAGE ON SCHEMA public TO api_user; GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO api_user;");
    await pg.db.exec("SET ROLE api_user");
    try {
      expect((await pg.db.query("SELECT COUNT(*)::int AS n FROM projects")).rows[0]).toEqual({ n: 0 }); // granted, yet no rows
      await expect(pg.db.query("INSERT INTO projects (id, name, website_url) VALUES ('q', 'Q', 'https://q.test/')")).rejects.toThrow(/row-level security/);
    } finally {
      await pg.db.exec("RESET ROLE");
    }
    expect((await pg.db.query("SELECT COUNT(*)::int AS n FROM projects")).rows[0]).toEqual({ n: 1 }); // the owner (the app) is unaffected
  });
});

/** Realistic SQLite data through the app's own repositories, with ties on timestamps and JSON columns. */
async function seedSqlite(db: LocalDatabaseProvider) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
  const alice = await db.projects.create(projectInput({ name: "Alice Shop" }), "user-alice");
  const bob = await db.projects.create(projectInput({ name: "Bob Blog", websiteUrl: "https://bob.test/" }), "user-bob");
  const { page } = await db.pages.addManual(alice.id, "https://alice.test/", "https://alice.test/");
  for (const name of ["a.pdf", "b.pdf", "c.pdf"]) {
    await db.documents.create({ projectId: alice.id, kind: "REFERENCE", fileName: name, mimeType: "application/pdf", sizeBytes: 10, storageKey: `projects/${alice.id}/${name}`, checksumSha256: "x" });
  }
  const runs = [];
  for (let i = 0; i < 3; i++) {
    runs.push(
      await db.testRuns.createAndEnqueue({ projectId: i === 2 ? bob.id : alice.id, configurationId: null, name: `Run ${i} — “quoted” ✓`, modules: ["links"], browsers: ["chromium"], viewports: ["desktop-1440x900"], pageIds: [page.id], configurationName: null, options: { allowFormSubmission: false, maxLinksPerPage: 10, navigationTimeoutMs: 1000 } }),
    );
  }
  for (const [i, status] of ["PASS", "FAIL", "NOT EXECUTED"].entries()) {
    const caseId = randomUUID();
    db.sqlite.prepare("INSERT INTO test_cases (id, project_id, test_run_id, page_id, module, title, steps) VALUES (?, ?, ?, ?, 'links', ?, ?)").run(caseId, alice.id, runs[0].id, page.id, `case ${i}`, JSON.stringify(["open", "click"]));
    db.sqlite.prepare("INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), runs[0].id, caseId, status, status === "NOT EXECUTED" ? null : "2026-03-01T10:00:01.000Z", 1234);
  }
  db.sqlite.prepare("INSERT INTO performance_results (id, test_run_id, source, lcp_ms, cls, performance_score, measured_at) VALUES (?, ?, 'LOCAL_BROWSER', 1234.5, 0.05, 0.875, '2026-03-01T10:00:02.000Z')").run(randomUUID(), runs[0].id);
  await db.activity.record({ projectId: alice.id, entityType: "project", entityId: alice.id, action: "created", summary: "first" });
  await db.activity.record({ projectId: alice.id, entityType: "project", entityId: alice.id, action: "updated", summary: "second" });
  await db.testRuns.requestCancel(runs[1].id);
  return { alice, bob, runs };
}

describe("SQLite → PostgreSQL import", () => {
  it("copies every table, keeps insertion order, and validates counts and contents", async () => {
    const lite = liteDb();
    const { alice } = await seedSqlite(lite);
    expect(preflightSqlite(lite.sqlite)).toEqual([]);
    const pg = await pgDb();
    const copied = await importSqliteIntoPostgres(lite.sqlite, pg.conn, { batchSize: 2 });
    expect(copied).toMatchObject({ projects: 2, documents: 3, test_runs: 3, jobs: 3, test_results: 3, activity_log: 2 });
    const report = await validateImport(lite.sqlite, pg.conn);
    expect(report.tables.filter((t) => !t.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables).toHaveLength(34);

    // Ties on created_at (same fake time) come back in the same order on both databases.
    const docs = new LocalDocumentRepository(pg.sql);
    expect((await docs.listByProject(alice.id)).map((d) => d.fileName)).toEqual((await lite.documents.listByProject(alice.id)).map((d) => d.fileName));
    expect((await new LocalTestRunRepository(pg.sql).list()).map((r) => r.id)).toEqual((await lite.testRuns.list()).map((r) => r.id));
    expect((await new LocalActivityRepository(pg.sql).list()).map((a) => a.summary)).toEqual(["second", "first"]);

    // New rows sort after every imported row (identity sequences moved past the imported rowids).
    const max = Number((await pg.db.query<{ m: number }>("SELECT MAX(rowid) AS m FROM documents")).rows[0].m);
    await docs.create({ projectId: alice.id, kind: "REFERENCE", fileName: "new.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "projects/new", checksumSha256: "y" });
    expect(Number((await pg.db.query<{ r: number }>("SELECT rowid AS r FROM documents WHERE file_name = 'new.pdf'")).rows[0].r)).toBeGreaterThan(max);
  });

  it("refuses to import into a database that already has data", async () => {
    const lite = liteDb();
    await seedSqlite(lite);
    const pg = await pgDb();
    await importSqliteIntoPostgres(lite.sqlite, pg.conn);
    await expect(importSqliteIntoPostgres(lite.sqlite, pg.conn)).rejects.toThrow(/is not empty/);
  });

  it("pre-flight reports data PostgreSQL would reject or store differently, and the import refuses it", async () => {
    const lite = liteDb();
    await seedSqlite(lite);
    const db = lite.sqlite;
    db.prepare("UPDATE documents SET size_bytes = 3000000000 WHERE rowid = 1").run(); // beyond 4-byte integer
    db.prepare("UPDATE projects SET description = 'a' || char(0) || 'b' WHERE rowid = 1").run(); // NUL character
    db.prepare("UPDATE projects SET website_url = x'68ff' WHERE rowid = 2").run(); // binary data in a TEXT column
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO documents (id, project_id, kind, file_name, mime_type, size_bytes, storage_key, checksum_sha256) VALUES ('orphan', 'gone', 'REFERENCE', 'f', 'm', 1, 'k-orphan', 's')").run();
    db.pragma("foreign_keys = ON");
    const problems = preflightSqlite(db).map((p) => `${p.table}.${p.column ?? ""}: ${p.problem}`);
    expect(problems).toEqual(
      expect.arrayContaining([
        "documents.size_bytes: not an integer within the 4-byte range",
        "projects.description: contains a NUL character (not allowed in PostgreSQL text)",
        "projects.website_url: stored as a non-text value in a TEXT column",
        "documents.: foreign key points to a missing projects row",
      ]),
    );
    const pg = await pgDb();
    await expect(importSqliteIntoPostgres(db, pg.conn)).rejects.toThrow(/pre-flight found/);
    expect(Number((await pg.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM projects")).rows[0].n)).toBe(0);
  });

  it("catches legacy rows that break a CHECK constraint before importing", async () => {
    const lite = liteDb();
    await seedSqlite(lite);
    // Written while CHECK constraints were ignored; SQLite's integrity check still reports it.
    lite.sqlite.pragma("ignore_check_constraints = ON");
    lite.sqlite.prepare("INSERT INTO bugs (id, project_id, title, severity) SELECT 'bad-bug', id, 'legacy', 'URGENT' FROM projects LIMIT 1").run();
    lite.sqlite.pragma("ignore_check_constraints = OFF");
    expect(preflightSqlite(lite.sqlite)).toEqual([{ table: "*", problem: "integrity: CHECK constraint failed in bugs" }]);
    const pg = await pgDb();
    await expect(importSqliteIntoPostgres(lite.sqlite, pg.conn)).rejects.toThrow(/pre-flight found 1 problem/);
  });

  it("rolls the whole import back when PostgreSQL rejects a row part-way", async () => {
    const lite = liteDb();
    await seedSqlite(lite);
    const pg = await pgDb();
    // Only in this disposable database: a rule the SQLite data breaks, hit after several tables were copied.
    await pg.db.exec("ALTER TABLE activity_log ADD CONSTRAINT test_only_reject CHECK (summary <> 'second')");
    await expect(importSqliteIntoPostgres(lite.sqlite, pg.conn)).rejects.toThrow(/test_only_reject/);
    for (const t of ["projects", "documents", "test_runs", "bugs"]) expect(Number((await pg.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n), t).toBe(0);
  });

  it("detects a mismatch after import", async () => {
    const lite = liteDb();
    await seedSqlite(lite);
    const pg = await pgDb();
    await importSqliteIntoPostgres(lite.sqlite, pg.conn);
    await pg.db.query("UPDATE projects SET name = 'Changed' WHERE name = 'Bob Blog'");
    await pg.db.query("DELETE FROM activity_log WHERE summary = 'first'");
    const report = await validateImport(lite.sqlite, pg.conn);
    expect(report.ok).toBe(false);
    expect(report.tables.filter((t) => !t.ok).map((t) => [t.table, t.sqliteRows, t.postgresRows])).toEqual([
      ["projects", 2, 2],
      ["activity_log", 2, 1],
    ]);
  });
});

describe("rowid tie-break columns", () => {
  it("are bigint identity (BY DEFAULT), NOT NULL, unique by index only, and never part of the primary key", async () => {
    const pg = await pgDb();
    const cols = (await pg.db.query<{ t: string; type: string; identity: string; notnull: boolean }>(
      "SELECT c.relname AS t, format_type(a.atttypid, a.atttypmod) AS type, a.attidentity AS identity, a.attnotnull AS notnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'rowid' AND NOT a.attisdropped",
    )).rows;
    expect(cols.map((c) => c.t).sort()).toEqual([...ROWID_TABLES].sort());
    for (const c of cols) expect({ type: c.type, identity: c.identity, notnull: c.notnull }, c.t).toEqual({ type: "bigint", identity: "d", notnull: true });
    const pks = (await pg.db.query<{ t: string; cols: string }>(
      "SELECT c.conrelid::regclass::text AS t, string_agg(a.attname, ',') AS cols FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) WHERE c.contype = 'p' AND c.connamespace = 'public'::regnamespace GROUP BY 1",
    )).rows;
    for (const t of ROWID_TABLES) expect(pks.find((p) => p.t === t)?.cols, t).toBe(t === "external_test_executions" ? "test_run_id" : "id");
    const idx = (await pg.db.query<{ t: string; def: string }>("SELECT tablename AS t, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx\\_%\\_rowid'")).rows;
    expect(idx.map((i) => i.t).sort()).toEqual([...ROWID_TABLES].sort());
    for (const i of idx) expect(i.def, i.t).toMatch(/^CREATE UNIQUE INDEX idx_\w+_rowid ON public\.\w+ USING btree \(rowid\)$/);
  });

  it("reject a duplicate rowid, while default inserts and imported rows never collide", async () => {
    const lite = liteDb();
    const project = await lite.projects.create(projectInput({ name: "Alpha" }), "o");
    for (let i = 0; i < 5; i++) await lite.documents.create({ projectId: project.id, kind: "REFERENCE", fileName: `d${i}.pdf`, mimeType: "application/pdf", sizeBytes: 1, storageKey: `projects/${project.id}/d${i}`, checksumSha256: "x" });
    lite.sqlite.prepare("DELETE FROM documents WHERE file_name IN ('d1.pdf','d3.pdf')").run(); // gaps in the SQLite rowids
    const pg = await pgDb();
    await importSqliteIntoPostgres(lite.sqlite, pg.conn, { batchSize: 2 });
    const docs = new LocalDocumentRepository(pg.sql);
    for (let i = 0; i < 4; i++) await docs.create({ projectId: project.id, kind: "REFERENCE", fileName: `n${i}.pdf`, mimeType: "application/pdf", sizeBytes: 1, storageKey: `projects/${project.id}/n${i}`, checksumSha256: "y" });
    const rowids = (await pg.db.query<{ r: string }>("SELECT rowid AS r FROM documents")).rows.map((r) => Number(r.r));
    expect(new Set(rowids).size).toBe(rowids.length);
    await expect(
      pg.db.query("INSERT INTO documents (id, project_id, kind, file_name, mime_type, size_bytes, storage_key, checksum_sha256, rowid) VALUES ('dup', $1, 'REFERENCE', 'dup.pdf', 'application/pdf', 1, 'projects/dup', 'z', $2)", [project.id, rowids[0]]),
    ).rejects.toThrow(/idx_documents_rowid/);
  });
});

describe("rollback script (lib/database/postgres/rollbacks/0001_initial_schema.down.sql)", () => {
  const ROLLBACK = fs.readFileSync(path.join(process.cwd(), "lib", "database", "postgres", "rollbacks", "0001_initial_schema.down.sql"), "utf8");
  /** Objects that exist before the migration (like Supabase's) and must survive both the migration and the rollback. */
  const OTHERS = [
    "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;",
    "CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text); INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001', 'a@b.test');",
    "CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY); INSERT INTO storage.buckets VALUES ('qa-pilot-artifacts');",
    "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;",
    "CREATE TABLE public.keep_me (id int PRIMARY KEY); INSERT INTO public.keep_me VALUES (1);",
    "CREATE FUNCTION public.keep_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';",
    "CREATE FUNCTION public.ddl_note() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;",
    "CREATE EVENT TRIGGER ddl_watch_like ON ddl_command_end EXECUTE FUNCTION public.ddl_note();",
  ].join("\n");
  const others = async (pg: PgTestDatabase) => {
    const q = async (sql: string) => (await pg.db.query<Record<string, unknown>>(sql)).rows.map((r) => Object.values(r).join(":")).sort();
    return [
      await q("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'"),
      await q("SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')"),
      await q("SELECT extname FROM pg_extension"),
      await q("SELECT evtname FROM pg_event_trigger"),
      await q("SELECT defaclobjtype, array_to_string(defaclacl, ',') FROM pg_default_acl"),
      await q("SELECT email FROM auth.users"),
      await q("SELECT id FROM storage.buckets"),
      await q("SELECT id FROM public.keep_me"),
      await q("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'"),
    ];
  };
  const publicObjects = async (pg: PgTestDatabase) =>
    (await pg.db.query<{ o: string }>("SELECT c.relkind::text || ':' || c.relname AS o FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY 1")).rows.map((r) => r.o);
  /** Like the hosted database before the first migration: other objects exist, nothing of ours in public. */
  async function emptyTarget() {
    const pg = await pgDb([]);
    await pg.db.exec("DROP TABLE qa_pilot_migrations"); // created by the helper's empty migration run
    await pg.db.exec(OTHERS);
    return pg;
  }

  it("removes exactly what the migration created, keeps everything else, and can be re-run", async () => {
    const pg = await emptyTarget();
    const before = { others: await others(pg), objects: await publicObjects(pg) };
    expect(await applyMigrations(pg.conn, loadMigrations())).toEqual([1]);
    expect(await others(pg)).toEqual(before.others); // the migration touches nothing else either
    await pg.db.query("INSERT INTO projects (id, name, website_url, owner_id) VALUES ('p1', 'A', 'https://a.test/', 'o')");
    await pg.db.exec("SET ROLE anon");
    expect((await pg.db.query<{ n: number }>("SELECT count(*)::int AS n FROM projects")).rows[0].n).toBe(0); // RLS without policies
    await pg.db.exec("RESET ROLE");
    await pg.db.query("DELETE FROM projects");
    await pg.db.exec(ROLLBACK);
    expect(await publicObjects(pg)).toEqual(before.objects);
    expect(await others(pg)).toEqual(before.others);
    await pg.db.exec(ROLLBACK);
    expect(await publicObjects(pg)).toEqual(before.objects);
    expect(await applyMigrations(pg.conn, loadMigrations())).toEqual([1]); // can be applied again
  });

  it("drops nothing when a table holds data or another object depends on the tables", async () => {
    const pg = await emptyTarget();
    await applyMigrations(pg.conn, loadMigrations());
    const migrated = await publicObjects(pg);
    await pg.db.query("INSERT INTO projects (id, name, website_url, owner_id) VALUES ('p1', 'A', 'https://a.test/', 'o')");
    await expect(pg.db.exec(ROLLBACK)).rejects.toThrow(/public\.projects contains 1 row\(s\); rollback stopped/);
    await pg.db.exec("ROLLBACK");
    expect(await publicObjects(pg)).toEqual(migrated);
    await pg.db.query("DELETE FROM projects");
    await pg.db.exec("CREATE VIEW public.someone_elses_view AS SELECT id FROM projects");
    const withView = await publicObjects(pg);
    await expect(pg.db.exec(ROLLBACK)).rejects.toThrow(/depend/);
    await pg.db.exec("ROLLBACK");
    expect(await publicObjects(pg)).toEqual(withView);
  });

  it("cleans up after a failed migration, which leaves only the empty tracking table", async () => {
    const pg = await emptyTarget();
    const before = await publicObjects(pg);
    const [real] = loadMigrations();
    await expect(applyMigrations(pg.conn, [{ ...real, sql: `${real.sql}\nSELECT * FROM table_that_does_not_exist;` }])).rejects.toThrow(/failed and was rolled back/);
    expect((await publicObjects(pg)).filter((o) => !before.includes(o)).sort()).toEqual(["i:qa_pilot_migrations_pkey", "r:qa_pilot_migrations"]);
    await pg.db.exec(ROLLBACK);
    expect(await publicObjects(pg)).toEqual(before);
  });
});
