import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { runMigrations } from "@/lib/database/local/sqlite-client";
import { EXPECTED_TABLES, LATEST_SCHEMA_VERSION } from "@/lib/database/schema";
import { DEFAULT_REPORT_SECTIONS } from "@/lib/constants/testing";
import { createTestDb, projectInput } from "./helpers";

let db: LocalDatabaseProvider;

beforeEach(() => {
  db = createTestDb();
});
afterEach(async () => {
  await db.close();
});

describe("schema", () => {
  it("creates every expected table with foreign keys enabled", () => {
    const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of EXPECTED_TABLES) expect(tables).toContain(t);
    expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("migrations are idempotent", () => {
    expect(runMigrations(db.sqlite)).toBe(LATEST_SCHEMA_VERSION);
    expect(runMigrations(db.sqlite)).toBe(LATEST_SCHEMA_VERSION);
  });

  it("reports healthy", async () => {
    expect(await db.healthCheck()).toMatchObject({ ok: true, schemaVersion: LATEST_SCHEMA_VERSION });
  });
});

/** Inserts a run + test case directly, as the future engine would. */
function seedRun(projectId: string, status = "COMPLETED", completedAt = new Date().toISOString()) {
  const runId = randomUUID();
  db.sqlite
    .prepare("INSERT INTO test_runs (id, project_id, status, completed_at) VALUES (?, ?, ?, ?)")
    .run(runId, projectId, status, completedAt);
  return runId;
}

function seedCase(projectId: string, runId: string, title = "Homepage links resolve") {
  const id = randomUUID();
  db.sqlite.prepare("INSERT INTO test_cases (id, project_id, test_run_id, module, title) VALUES (?, ?, ?, 'links', ?)").run(id, projectId, runId, title);
  return id;
}

function seedResult(runId: string, caseId: string, status: string, executedAt: string | null = new Date().toISOString()) {
  db.sqlite
    .prepare("INSERT INTO test_results (id, test_run_id, test_case_id, status, executed_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), runId, caseId, status, executedAt);
}

describe("result integrity constraints", () => {
  it("refuses PASS / FAIL / WARNING without an execution timestamp", async () => {
    const p = await db.projects.create(projectInput());
    const run = seedRun(p.id);
    const tc = seedCase(p.id, run);
    for (const status of ["PASS", "FAIL", "WARNING"]) {
      expect(() => seedResult(run, tc, status, null)).toThrow(/CHECK constraint/);
    }
    expect(() => seedResult(run, tc, "NOT EXECUTED", null)).not.toThrow();
    expect(() => seedResult(run, tc, "NOT APPLICABLE", null)).not.toThrow();
  });

  it("rejects unknown result and run statuses", async () => {
    const p = await db.projects.create(projectInput());
    const run = seedRun(p.id);
    const tc = seedCase(p.id, run);
    expect(() => seedResult(run, tc, "PASSED")).toThrow(/CHECK constraint/);
    expect(() => seedRun(p.id, "COMPLETED_OK")).toThrow(/CHECK constraint/);
    // Run statuses and result statuses are distinct sets.
    expect(() => seedRun(p.id, "PASS")).toThrow(/CHECK constraint/);
    expect(() => seedResult(run, tc, "COMPLETED")).toThrow(/CHECK constraint/);
  });
});

describe("projects repository", () => {
  it("creates, reads, updates and deletes", async () => {
    const created = await db.projects.create(projectInput({ description: "Main site" }));
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const read = await db.projects.getById(created.id);
    expect(read).toMatchObject({ name: "Example Site", description: "Main site", testRunCount: 0, pageCount: 0, referenceDocument: null });

    const updated = await db.projects.update(created.id, projectInput({ name: "Renamed", testEmail: "qa@example.com" }));
    expect(updated).toMatchObject({ name: "Renamed", testEmail: "qa@example.com" });
    expect(await db.projects.update("missing", projectInput())).toBeNull();

    expect(await db.projects.delete(created.id)).toBe(true);
    expect(await db.projects.getById(created.id)).toBeNull();
    expect(await db.projects.delete(created.id)).toBe(false);
  });

  it("searches literally (wildcards escaped) across name, url and description", async () => {
    await db.projects.create(projectInput({ name: "Alpha Shop", websiteUrl: "https://alpha.com/" }));
    await db.projects.create(projectInput({ name: "Beta", websiteUrl: "https://beta.io/", description: "100% coverage" }));
    expect((await db.projects.list({ search: "alpha" })).map((p) => p.name)).toEqual(["Alpha Shop"]);
    expect((await db.projects.list({ search: "beta.io" })).map((p) => p.name)).toEqual(["Beta"]);
    expect((await db.projects.list({ search: "100%" })).map((p) => p.name)).toEqual(["Beta"]);
    expect(await db.projects.list({ search: "%" })).toHaveLength(1);
    expect(await db.projects.list({ search: "_" })).toHaveLength(0);
  });

  it("filters and sorts", async () => {
    const a = await db.projects.create(projectInput({ name: "Zeta", figmaUrl: "https://www.figma.com/design/K/x" }));
    await db.projects.create(projectInput({ name: "alpha", testEmail: "qa@example.com" }));
    seedRun(a.id);
    expect((await db.projects.list({ filter: "with-figma" })).map((p) => p.name)).toEqual(["Zeta"]);
    expect((await db.projects.list({ filter: "with-test-email" })).map((p) => p.name)).toEqual(["alpha"]);
    expect((await db.projects.list({ filter: "never-run" })).map((p) => p.name)).toEqual(["alpha"]);
    expect((await db.projects.list({ sort: "name" })).map((p) => p.name)).toEqual(["alpha", "Zeta"]);
    expect((await db.projects.getById(a.id))?.testRunCount).toBe(1);
  });

  it("cascades deletes to all project-owned records", async () => {
    const p = await db.projects.create(projectInput());
    await db.documents.create({ projectId: p.id, kind: "REFERENCE", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "k1", checksumSha256: "x" });
    const run = seedRun(p.id);
    seedResult(run, seedCase(p.id, run), "PASS");
    await db.projects.delete(p.id);
    for (const table of ["documents", "test_runs", "test_cases", "test_results"]) {
      expect((db.sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c).toBe(0);
    }
  });
});

describe("test configurations repository", () => {
  it("round-trips JSON fields and scopes updates to the owning project", async () => {
    const p = await db.projects.create(projectInput());
    const input = {
      projectId: p.id,
      name: "Smoke",
      scope: "MANUAL_URLS" as const,
      selectedPageIds: [],
      manualUrls: ["https://example.com/a"],
      modules: ["links", "seo"],
      browsers: ["chromium" as const],
      viewports: ["mobile-390x844"],
      reportFormats: ["EXCEL" as const],
      reportSections: DEFAULT_REPORT_SECTIONS,
    };
    const created = await db.testConfigurations.create(input);
    expect(await db.testConfigurations.getById(created.id)).toMatchObject(input);
    expect(await db.testConfigurations.update(created.id, { ...input, projectId: "other" })).toBeNull();
    expect((await db.testConfigurations.update(created.id, { ...input, name: "Full" }))?.name).toBe("Full");
    expect(await db.testConfigurations.listByProject(p.id)).toHaveLength(1);
  });
});

describe("dashboard repository", () => {
  it("returns zeros, not fabricated numbers, for an empty database", async () => {
    const metrics = await db.dashboard.getMetrics();
    expect(Object.values(metrics).every((v) => v === 0)).toBe(true);
    expect(await db.dashboard.getResultTrend(30)).toEqual([]);
    expect(await db.dashboard.getRegressions()).toEqual([]);
  });

  it("counts only recorded results and bugs", async () => {
    const p = await db.projects.create(projectInput());
    const run = seedRun(p.id);
    const tc = seedCase(p.id, run);
    seedResult(run, tc, "PASS");
    seedResult(run, tc, "FAIL");
    seedResult(run, tc, "WARNING");
    seedResult(run, tc, "NOT EXECUTED", null);
    db.sqlite.prepare("INSERT INTO bugs (id, project_id, title, severity) VALUES (?, ?, 'Broken link', 'HIGH')").run(randomUUID(), p.id);

    const m = await db.dashboard.getMetrics();
    expect(m).toMatchObject({ totalProjects: 1, totalTestRuns: 1, totalTestCases: 1, passed: 1, failed: 1, warnings: 1, bugs: 1, highBugs: 1, criticalBugs: 0 });
    const trend = await db.dashboard.getResultTrend(7);
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ passed: 1, failed: 1, warnings: 1 });
  });

  it("detects a regression between the two latest completed runs", async () => {
    const p = await db.projects.create(projectInput());
    const prev = seedRun(p.id, "COMPLETED", "2026-01-01T00:00:00.000Z");
    const latest = seedRun(p.id, "COMPLETED", "2026-01-02T00:00:00.000Z");
    seedResult(prev, seedCase(p.id, prev), "PASS");
    seedResult(latest, seedCase(p.id, latest), "FAIL");
    const regressions = await db.dashboard.getRegressions();
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ previousRunId: prev, latestRunId: latest, testCaseTitle: "Homepage links resolve" });
  });
});

describe("activity repository", () => {
  it("records entries and keeps them after the project is deleted", async () => {
    const p = await db.projects.create(projectInput());
    await db.activity.record({ projectId: p.id, entityType: "project", entityId: p.id, action: "created", summary: "created" });
    await db.projects.delete(p.id);
    const entries = await db.activity.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].projectId).toBeNull();
  });
});
