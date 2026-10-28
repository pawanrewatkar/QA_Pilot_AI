import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { SqliteExecutor } from "@/lib/database/sql/sqlite-executor";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import { loadReportData } from "@/lib/reports/data";
import { createTestDb, projectInput } from "./helpers";

/**
 * Test results repository: `isKnownArtifact` (in-memory SQLite only), and the two places that construct the
 * repository (the database provider and report data loading). Pins found / not found, the single bound storage key,
 * and the owner check in the scoped provider, so the method can move onto the SQL executor unchanged. Rows are seeded
 * directly.
 *
 * Set QA_ARTIFACT_BEHAVIOUR_OUT to a file path to also write the observations as JSON (used to compare the
 * implementation before and after a refactor).
 */

// Records the constructor arguments of every LocalTestResultRepository, wherever it is created.
const { constructed } = vi.hoisted(() => ({ constructed: [] as unknown[][] }));
vi.mock("@/lib/database/local/engine-repositories", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/database/local/engine-repositories")>();
  class RecordingTestResultRepository extends mod.LocalTestResultRepository {
    constructor(...args: ConstructorParameters<typeof mod.LocalTestResultRepository>) {
      super(...args);
      constructed.push(args);
    }
  }
  return { ...mod, LocalTestResultRepository: RecordingTestResultRepository };
});

let base: LocalDatabaseProvider;
let aliceRun: string;
let bobRun: string;
let aliceKey: string;
let bobKey: string;

const exec = (sql: string, ...args: unknown[]) => base.sqlite.prepare(sql).run(...args);

async function seedRun(owner: string, name: string) {
  const project = await base.projects.create(projectInput({ name, websiteUrl: `https://${name}.test/` }), owner);
  const runId = `run-${name}`;
  exec("INSERT INTO test_runs (id, project_id, status) VALUES (?, ?, 'COMPLETED')", runId, project.id);
  return runId;
}
function screenshot(runId: string, key: string) {
  exec("INSERT INTO screenshots (id, test_run_id, storage_key, captured_at) VALUES (?, ?, ?, '2026-03-01T00:00:00.000Z')", `shot-${key}`, runId, key);
  return key;
}

/** Records the SQL and bound arguments of the artifact lookup at the better-sqlite3 level (old and new code). */
function captureBindings() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = base.sqlite.prepare.bind(base.sqlite);
  vi.spyOn(base.sqlite, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (!sql.includes("FROM screenshots WHERE storage_key")) return stmt;
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "get") return (...args: unknown[]) => (calls.push({ sql, args }), target.get(...args));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof base.sqlite.prepare);
  return calls;
}

beforeEach(async () => {
  constructed.length = 0;
  base = createTestDb();
  aliceRun = await seedRun("user-alice", "alice");
  bobRun = await seedRun("user-bob", "bob");
  aliceKey = screenshot(aliceRun, `runs/${aliceRun}/page/chromium-desktop/01-viewport.png`);
  bobKey = screenshot(bobRun, `runs/${bobRun}/page/chromium-desktop/01-viewport.png`);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await base.close();
});

describe("test results repository: isKnownArtifact", () => {
  it("finds a recorded screenshot and rejects unknown keys", async () => {
    expect(await base.testResults.isKnownArtifact(aliceKey)).toBe(true);
    expect(await base.testResults.isKnownArtifact(bobKey)).toBe(true);
    expect(await base.testResults.isKnownArtifact(`runs/${aliceRun}/page/chromium-desktop/02-missing.png`)).toBe(false);
    expect(await base.testResults.isKnownArtifact("")).toBe(false);
    // Exact match only: no prefix or pattern matching.
    expect(await base.testResults.isKnownArtifact(`runs/${aliceRun}/`)).toBe(false);
    expect(await base.testResults.isKnownArtifact(`runs/${aliceRun}/page/chromium-desktop/%`)).toBe(false);
    expect(await base.testResults.isKnownArtifact(aliceKey.toUpperCase())).toBe(false);
  });

  it("returns a boolean and stops finding a screenshot once its run is deleted", async () => {
    const found = await base.testResults.isKnownArtifact(aliceKey);
    expect(typeof found).toBe("boolean");
    exec("DELETE FROM test_runs WHERE id = ?", aliceRun); // screenshots cascade with their run
    expect(await base.testResults.isKnownArtifact(aliceKey)).toBe(false);
    expect(await base.testResults.isKnownArtifact(bobKey)).toBe(true);
  });

  it("binds only the storage key", async () => {
    const calls = captureBindings();
    await base.testResults.isKnownArtifact(aliceKey);
    await base.testResults.isKnownArtifact("missing");
    expect(calls.map((c) => c.args)).toEqual([[aliceKey], ["missing"]]);
    expect(calls[0].sql).toBe("SELECT 1 FROM screenshots WHERE storage_key = ? LIMIT 1");
  });

  it("checks ownership in the scoped provider before looking the key up", async () => {
    const order: string[] = [];
    const ownerOf = base.ownership.ownerOf.bind(base.ownership);
    vi.spyOn(base.ownership, "ownerOf").mockImplementation(async (resource, id) => (order.push(`owner:${resource}`), ownerOf(resource, id)));
    const lookup = base.testResults.isKnownArtifact.bind(base.testResults);
    const isKnown = vi.spyOn(base.testResults, "isKnownArtifact").mockImplementation(async (key) => (order.push("lookup"), lookup(key)));
    const alice = new OwnerScopedDatabaseProvider(base, "user-alice");
    const bob = new OwnerScopedDatabaseProvider(base, "user-bob");

    expect(await alice.testResults.isKnownArtifact(aliceKey)).toBe(true);
    expect(order).toEqual(["owner:storageKey", "lookup"]);

    order.length = 0;
    isKnown.mockClear();
    expect(await bob.testResults.isKnownArtifact(aliceKey)).toBe(false); // another owner's screenshot
    expect(await alice.testResults.isKnownArtifact("reports/x/file.pdf")).toBe(false); // unknown owner resource
    expect(await alice.testResults.isKnownArtifact("not-a-key")).toBe(false); // unrecognised key
    expect(isKnown).not.toHaveBeenCalled(); // never looked up without ownership
    expect(await bob.testResults.isKnownArtifact(bobKey)).toBe(true);
    expect(await alice.testResults.isKnownArtifact(`runs/${aliceRun}/page/chromium-desktop/02-missing.png`)).toBe(false); // owned run, unknown file
  });
});

describe("test results repository: construction", () => {
  it("the database provider gives the repository its connection and its SQL executor", () => {
    const db = createTestDb();
    try {
      expect(constructed).toHaveLength(2); // base (beforeEach) + db
      const [conn, sql] = constructed[1];
      expect(conn).toBe(db.sqlite);
      expect(sql).toBe(db.sql); // the provider's shared executor
    } finally {
      void db.close();
    }
  });

  it("report data loading gives the repository an executor over the same connection", async () => {
    constructed.length = 0;
    await loadReportData(base.sqlite, aliceRun);
    expect(constructed).toHaveLength(1);
    const [conn, sql] = constructed[0];
    expect(conn).toBe(base.sqlite);
    expect(sql).toBeInstanceOf(SqliteExecutor);
    // Same connection: the in-memory database is only visible through this connection.
    expect(await (sql as SqliteExecutor).get("SELECT id FROM test_runs WHERE id = ?", [aliceRun])).toEqual({ id: aliceRun });
  });
});

describe("test results repository: behaviour snapshot", () => {
  it("produces the recorded behaviour snapshot", async () => {
    const calls = captureBindings();
    const keys = [aliceKey, bobKey, "missing", "", `runs/${aliceRun}/`, aliceKey.toUpperCase()];
    const out: Record<string, unknown> = { base: [] as unknown[], alice: [] as unknown[], bob: [] as unknown[] };
    const alice = new OwnerScopedDatabaseProvider(base, "user-alice");
    const bob = new OwnerScopedDatabaseProvider(base, "user-bob");
    for (const key of keys) {
      (out.base as unknown[]).push(await base.testResults.isKnownArtifact(key));
      (out.alice as unknown[]).push(await alice.testResults.isKnownArtifact(key));
      (out.bob as unknown[]).push(await bob.testResults.isKnownArtifact(key));
    }
    out.bindings = calls.map((c) => c.args);
    out.sql = [...new Set(calls.map((c) => c.sql))];
    if (process.env.QA_ARTIFACT_BEHAVIOUR_OUT) fs.writeFileSync(process.env.QA_ARTIFACT_BEHAVIOUR_OUT, JSON.stringify(out, null, 2));
    expect(out.base).toEqual([true, true, false, false, false, false]);
  });
});
