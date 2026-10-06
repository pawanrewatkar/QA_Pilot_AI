import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { createProject, deleteProject, updateProject, type ProjectServiceDeps } from "@/lib/services/projects";
import { saveTestConfiguration } from "@/lib/services/test-configurations";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { DEFAULT_REPORT_SECTIONS } from "@/lib/constants/testing";
import { createTestDb, makeTempDir, PDF_BYTES } from "./helpers";

let db: LocalDatabaseProvider;
let root: string;
let deps: ProjectServiceDeps;

const fields = { name: "Docs Site", websiteUrl: "docs.example.com", description: "", figmaUrl: "", testEmail: "" };

beforeEach(() => {
  db = createTestDb();
  root = makeTempDir();
  deps = { db, storage: new LocalStorageProvider(root), maxUploadBytes: 1024 };
});
afterEach(async () => {
  await db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const filesUnder = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length : 0);

describe("project service", () => {
  it("creates a project with a stored reference document and logs activity", async () => {
    const result = await createProject(deps, fields, { name: "spec.pdf", bytes: PDF_BYTES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const project = await db.projects.getById(result.project.id);
    expect(project?.websiteUrl).toBe("https://docs.example.com/");
    expect(project?.referenceDocument).toMatchObject({ fileName: "spec.pdf", mimeType: "application/pdf", sizeBytes: PDF_BYTES.length });
    expect(await deps.storage.get(project!.referenceDocument!.storageKey)).toEqual(PDF_BYTES);
    expect((await db.activity.list())[0]).toMatchObject({ action: "created", entityType: "project" });
  });

  it("rejects invalid fields and bad uploads without writing anything", async () => {
    const bad = await createProject(deps, { ...fields, websiteUrl: "javascript:alert(1)" }, null);
    expect(bad.ok).toBe(false);

    const fakePdf = await createProject(deps, fields, { name: "spec.pdf", bytes: new TextEncoder().encode("not a pdf") });
    expect(fakePdf).toMatchObject({ ok: false, errors: { referenceDocument: expect.stringContaining("does not match") } });

    const exe = await createProject(deps, fields, { name: "tool.exe", bytes: PDF_BYTES });
    expect(exe).toMatchObject({ ok: false, errors: { referenceDocument: expect.stringContaining("Unsupported") } });

    const big = await createProject(deps, fields, { name: "big.txt", bytes: new Uint8Array(2048).fill(65) });
    expect(big).toMatchObject({ ok: false, errors: { referenceDocument: expect.stringContaining("too large") } });

    expect(await db.projects.count()).toBe(0);
    expect(filesUnder(root)).toBe(0);
  });

  it("replaces and removes the reference document on update", async () => {
    const created = await createProject(deps, fields, { name: "v1.pdf", bytes: PDF_BYTES });
    if (!created.ok) throw new Error("setup failed");
    const id = created.project.id;

    await updateProject(deps, id, fields, { file: { name: "v2.txt", bytes: new TextEncoder().encode("hello") }, removeDocument: false });
    let docs = await db.documents.listByProject(id);
    expect(docs.map((d) => d.fileName)).toEqual(["v2.txt"]);
    expect(filesUnder(path.join(root, "projects", id))).toBe(1);

    await updateProject(deps, id, fields, { file: null, removeDocument: true });
    docs = await db.documents.listByProject(id);
    expect(docs).toHaveLength(0);
    expect(filesUnder(path.join(root, "projects", id))).toBe(0);
  });

  it("returns a form error when updating a missing project", async () => {
    expect(await updateProject(deps, "missing", fields, { file: null, removeDocument: false })).toMatchObject({ ok: false, errors: { form: expect.any(String) } });
  });

  it("deletes the project, its files and records the deletion", async () => {
    const created = await createProject(deps, fields, { name: "v1.pdf", bytes: PDF_BYTES });
    if (!created.ok) throw new Error("setup failed");
    expect(await deleteProject(deps, created.project.id)).toBe(true);
    expect(await db.projects.getById(created.project.id)).toBeNull();
    expect(filesUnder(root)).toBe(0);
    expect((await db.activity.list())[0]).toMatchObject({ action: "deleted", projectId: null });
    expect(await deleteProject(deps, created.project.id)).toBe(false);
  });

  it("saves a test configuration through the service", async () => {
    const created = await createProject(deps, fields, null);
    if (!created.ok) throw new Error("setup failed");
    const payload = {
      name: "Smoke",
      scope: "MANUAL_URLS",
      selectedPageIds: [],
      manualUrls: "https://docs.example.com/a\nhttps://docs.example.com/b",
      modules: ["links"],
      browsers: ["firefox"],
      viewports: ["desktop-1366x768"],
      reportFormats: [],
      reportSections: DEFAULT_REPORT_SECTIONS,
    };
    const saved = await saveTestConfiguration(db, created.project.id, null, payload);
    expect(saved.ok && saved.configuration.manualUrls).toEqual(["https://docs.example.com/a", "https://docs.example.com/b"]);
    const offSite = await saveTestConfiguration(db, created.project.id, null, { ...payload, manualUrls: "https://evil.com/" });
    expect(offSite.ok).toBe(false);
    // Saving a configuration must never create runs or results.
    expect((await db.dashboard.getMetrics()).totalTestRuns).toBe(0);
  });
});
