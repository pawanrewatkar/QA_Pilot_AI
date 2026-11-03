import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider, ResourceNotFoundError } from "@/lib/database/owner-scoped-provider";
import type { NewDocumentRecord } from "@/types";
import { createTestDb, projectInput } from "./helpers";

/**
 * Documents repository behaviour (in-memory SQLite only). Pins results, ordering, nulls, errors and ownership
 * so the repository can move onto the SQL executor without any observable change.
 *
 * Set QA_DOCS_BEHAVIOUR_OUT to a file path to also write the normalized observations as JSON (used to compare
 * the implementation before and after a refactor).
 */

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-03-02T10:00:00.000Z";

let base: LocalDatabaseProvider;
let alice: OwnerScopedDatabaseProvider;
let bob: OwnerScopedDatabaseProvider;
let aliceProject: string;
let bobProject: string;

const doc = (projectId: string, n: number, over: Partial<NewDocumentRecord> = {}): NewDocumentRecord => ({
  projectId,
  kind: "REFERENCE",
  fileName: `ref-${n}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: n * 100,
  storageKey: `projects/${projectId}/documents/${n}.pdf`,
  checksumSha256: `sha-${n}`,
  ...over,
});

async function createAt(time: string, input: NewDocumentRecord) {
  vi.setSystemTime(new Date(time));
  return base.documents.create(input);
}

const errorOf = async (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: Error) => `${e.name}: ${e.message}`,
  );

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  base = createTestDb();
  aliceProject = (await base.projects.create(projectInput({ name: "Alice" }), "user-alice")).id;
  bobProject = (await base.projects.create(projectInput({ name: "Bob", websiteUrl: "https://bob.test/" }), "user-bob")).id;
  alice = new OwnerScopedDatabaseProvider(base, "user-alice");
  bob = new OwnerScopedDatabaseProvider(base, "user-bob");
});
afterEach(async () => {
  vi.useRealTimers();
  await base.close();
});

describe("documents repository", () => {
  it("returns empty results and nulls for missing records", async () => {
    expect(await base.documents.listByProject(aliceProject)).toEqual([]);
    expect(await base.documents.listByProject("no-such-project")).toEqual([]);
    expect(await base.documents.getById("no-such-document")).toBeNull();
    expect(await base.documents.getById("")).toBeNull();
    expect(await base.documents.delete("no-such-document")).toBe(false);
  });

  it("creates, reads, orders and deletes documents exactly as before", async () => {
    const d1 = await createAt(T1, doc(aliceProject, 1));
    const d2 = await createAt(T2, doc(aliceProject, 2, { kind: "OTHER", fileName: "Spécification ✓.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    const d3 = await createAt(T2, doc(aliceProject, 3)); // same timestamp as d2: newest insert first
    await createAt(T1, doc(bobProject, 4));

    expect(d1).toEqual({ id: d1.id, projectId: aliceProject, kind: "REFERENCE", fileName: "ref-1.pdf", mimeType: "application/pdf", sizeBytes: 100, storageKey: `projects/${aliceProject}/documents/1.pdf`, checksumSha256: "sha-1", createdAt: T1 });
    expect(typeof d1.sizeBytes).toBe("number");
    expect(await base.documents.getById(d2.id)).toEqual(d2);
    expect(d2.fileName).toBe("Spécification ✓.docx");
    expect((await base.documents.listByProject(aliceProject)).map((d) => d.id)).toEqual([d3.id, d2.id, d1.id]);

    expect(await base.documents.delete(d2.id)).toBe(true);
    expect(await base.documents.delete(d2.id)).toBe(false);
    expect(await base.documents.getById(d2.id)).toBeNull();
    expect((await base.documents.listByProject(aliceProject)).map((d) => d.id)).toEqual([d3.id, d1.id]);
    expect(await base.documents.listByProject(bobProject)).toHaveLength(1);
  });

  it("rejects invalid rows with the same database errors", async () => {
    await createAt(T1, doc(aliceProject, 1));
    expect(await errorOf(base.documents.create(doc("no-such-project", 9)))).toBe("SqliteError: FOREIGN KEY constraint failed");
    expect(await errorOf(base.documents.create(doc(aliceProject, 1, { fileName: "dup.pdf" })))).toBe("SqliteError: UNIQUE constraint failed: documents.storage_key");
    expect(await errorOf(base.documents.create(doc(aliceProject, 5, { kind: "SECRET" as never })))).toMatch(/^SqliteError: CHECK constraint failed/);
    expect(await errorOf(base.documents.create(doc(aliceProject, 6, { sizeBytes: -1 })))).toMatch(/^SqliteError: CHECK constraint failed/);
    expect(await base.documents.listByProject(aliceProject)).toHaveLength(1); // nothing partial was written
  });

  it("keeps documents isolated per owner through the scoped provider", async () => {
    const a = await createAt(T1, doc(aliceProject, 1));
    expect(await alice.documents.getById(a.id)).toEqual(a);
    expect(await alice.documents.listByProject(aliceProject)).toEqual([a]);
    expect(await bob.documents.getById(a.id)).toBeNull();
    expect(await bob.documents.listByProject(aliceProject)).toEqual([]);
    expect(await bob.documents.delete(a.id)).toBe(false);
    await expect(bob.documents.create(doc(aliceProject, 2))).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await base.documents.listByProject(aliceProject)).toEqual([a]); // untouched by bob
    expect(await alice.documents.delete(a.id)).toBe(true);
  });

  it("removes a project's documents with the project", async () => {
    await createAt(T1, doc(aliceProject, 1));
    expect(await base.projects.delete(aliceProject)).toBe(true);
    expect(await base.documents.listByProject(aliceProject)).toEqual([]);
  });

  it("produces the recorded behaviour snapshot", async () => {
    const labels = new Map<string, string>();
    const label = (id: string) => labels.get(id) ?? (labels.set(id, `doc${labels.size + 1}`), labels.get(id)!);
    const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === "id" && typeof x === "string" ? label(x) : x)));
    const out: Record<string, unknown> = {};
    out.emptyList = norm(await base.documents.listByProject(aliceProject));
    out.missingGet = norm(await base.documents.getById("missing"));
    out.missingDelete = await base.documents.delete("missing");
    const d1 = await createAt(T1, doc(aliceProject, 1));
    const d2 = await createAt(T2, doc(aliceProject, 2));
    const d3 = await createAt(T2, doc(aliceProject, 3));
    out.created = norm([d1, d2, d3]);
    out.list = norm(await base.documents.listByProject(aliceProject));
    out.get = norm(await base.documents.getById(d2.id));
    out.errors = [
      await errorOf(base.documents.create(doc("no-such-project", 9))),
      await errorOf(base.documents.create(doc(aliceProject, 1))),
      await errorOf(base.documents.create(doc(aliceProject, 7, { kind: "SECRET" as never }))),
    ];
    out.scoped = { bobGet: norm(await bob.documents.getById(d1.id)), bobList: norm(await bob.documents.listByProject(aliceProject)), bobDelete: await bob.documents.delete(d1.id), aliceList: norm(await alice.documents.listByProject(aliceProject)) };
    out.deletes = [await base.documents.delete(d2.id), await base.documents.delete(d2.id)];
    out.listAfterDelete = norm(await base.documents.listByProject(aliceProject));
    out.raw = base.sqlite.prepare("SELECT kind, file_name, mime_type, size_bytes, typeof(size_bytes) AS t, storage_key, checksum_sha256, created_at FROM documents ORDER BY storage_key").all();
    if (process.env.QA_DOCS_BEHAVIOUR_OUT) {
      // Project ids are random per run; replace them so two runs can be compared byte for byte.
      const text = JSON.stringify(out, null, 2).replaceAll(aliceProject, "<alice-project>").replaceAll(bobProject, "<bob-project>");
      fs.writeFileSync(process.env.QA_DOCS_BEHAVIOUR_OUT, text);
    }
    expect(out.list).toEqual([out.created as unknown[]].flatMap((c) => [c[2], c[1], c[0]]));
    expect(out.scoped).toMatchObject({ bobGet: null, bobList: [], bobDelete: false });
  });
});
