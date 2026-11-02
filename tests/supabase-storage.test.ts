import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "@/lib/config/env";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { InvalidStorageKeyError, type StorageProvider } from "@/lib/storage/provider";
import { createStorageProvider, createSupabaseBucket, StorageConfigurationError, supabaseStorageConfig } from "@/lib/storage/select";
import { BUCKET, FakeStorageServer, SECRET } from "./support/fake-storage";
import { StorageObjectTooLargeError, StorageOperationError, SupabaseStorageProvider, type StorageBucketApi } from "@/lib/storage/supabase-storage-provider";

/**
 * Supabase Storage provider, against a disposable fake of the Supabase Storage HTTP API on 127.0.0.1 driven by the
 * real @supabase/supabase-js client (no hosted project, no network), plus an in-memory bucket for paging and failure
 * cases. The same contract runs against the local filesystem provider, so both behave the same for the app.
 */

const bytes = (s: string) => new Uint8Array(Buffer.from(s));
const text = (b: Uint8Array | null) => (b ? Buffer.from(b).toString() : null);

let server: FakeStorageServer;
beforeAll(async () => {
  server = new FakeStorageServer();
  await server.start();
});
afterAll(async () => {
  await server.stop();
});

const supabaseProvider = (options: Partial<{ maxObjectBytes: number; attempts: number }> = {}) =>
  new SupabaseStorageProvider(createSupabaseBucket(server.url, SECRET, BUCKET), { maxObjectBytes: 1024 * 1024, retryDelayMs: 1, ...options });

/** The behaviour the app relies on, for any StorageProvider. */
function contract(name: string, make: () => StorageProvider) {
  describe(`storage contract: ${name}`, () => {
    let storage: StorageProvider;
    beforeEach(() => {
      server.objects.clear();
      server.requests = [];
      server.failNext = [];
      storage = make();
    });

    it("stores, reads back and replaces objects", async () => {
      expect(await storage.put("runs/r1/p1/chromium-desktop/01-viewport.png", bytes("png-1"))).toEqual({ key: "runs/r1/p1/chromium-desktop/01-viewport.png", sizeBytes: 5 });
      expect(text(await storage.get("runs/r1/p1/chromium-desktop/01-viewport.png"))).toBe("png-1");
      await storage.put("runs/r1/p1/chromium-desktop/01-viewport.png", bytes("png-2"));
      expect(text(await storage.get("runs/r1/p1/chromium-desktop/01-viewport.png"))).toBe("png-2");
      expect(await storage.exists("runs/r1/p1/chromium-desktop/01-viewport.png")).toBe(true);
    });

    it("reports missing objects without throwing", async () => {
      expect(await storage.get("reports/none/report.pdf")).toBeNull();
      expect(await storage.exists("reports/none/report.pdf")).toBe(false);
      expect(await storage.delete("reports/none/report.pdf")).toBe(false);
      expect(await storage.deletePrefix("reports/none")).toBe(0);
    });

    it("deletes single objects and whole prefixes, leaving everything else", async () => {
      for (const k of ["reports/b1/r.pdf", "reports/b1/r.xlsx", "reports/b1/sub/img.png", "reports/b2/r.pdf", "projects/p/documents/a.pdf"]) await storage.put(k, bytes(k));
      expect(await storage.delete("projects/p/documents/a.pdf")).toBe(true);
      expect(await storage.exists("projects/p/documents/a.pdf")).toBe(false);
      expect(await storage.deletePrefix("reports/b1/")).toBe(3);
      expect(await storage.exists("reports/b1/sub/img.png")).toBe(false);
      expect(text(await storage.get("reports/b2/r.pdf"))).toBe("reports/b2/r.pdf");
    });

    it("rejects unsafe keys before touching storage", async () => {
      for (const key of ["../etc/passwd", "/abs/key.png", "runs\\x.png", "runs/../x.png", ""]) {
        await expect(storage.put(key, bytes("x")), key).rejects.toThrow(InvalidStorageKeyError);
        await expect(storage.get(key), key).rejects.toThrow(InvalidStorageKeyError);
      }
      await expect(storage.deletePrefix("../")).rejects.toThrow(InvalidStorageKeyError);
    });
  });
}

const tmpDirs: string[] = [];
contract("local filesystem", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-storage-"));
  tmpDirs.push(dir);
  return new LocalStorageProvider(dir);
});
contract("Supabase Storage (real client, fake server)", () => supabaseProvider());
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("Supabase Storage: requests and failures", () => {
  beforeEach(() => {
    server.objects.clear();
    server.requests = [];
    server.failNext = [];
  });

  it("authenticates every request with the server-side key and sends content types with upsert", async () => {
    const storage = supabaseProvider();
    await storage.put("reports/b/report.pdf", bytes("%PDF"));
    await storage.put("runs/r/p/x.png", bytes("png"));
    await storage.put("reports/b/data.bin", bytes("x"), { contentType: "application/x-custom" });
    await storage.get("reports/b/report.pdf");
    expect(server.requests.every((r) => r.apikey === SECRET)).toBe(true);
    const uploads = server.requests.filter((r) => r.method === "POST");
    expect(uploads.map((r) => [r.path, r.contentType, r.upsert])).toEqual([
      [`/storage/v1/object/${BUCKET}/reports/b/report.pdf`, "application/pdf", "true"],
      [`/storage/v1/object/${BUCKET}/runs/r/p/x.png`, "image/png", "true"],
      [`/storage/v1/object/${BUCKET}/reports/b/data.bin`, "application/x-custom", "true"],
    ]);
    expect(server.objects.get("reports/b/report.pdf")?.contentType).toBe("application/pdf");
  });

  it("refuses objects over the size limit without uploading anything", async () => {
    const storage = supabaseProvider({ maxObjectBytes: 10 });
    await expect(storage.put("reports/b/big.pdf", new Uint8Array(11))).rejects.toThrow(StorageObjectTooLargeError);
    expect(server.requests).toEqual([]);
    await storage.put("reports/b/ok.pdf", new Uint8Array(10));
    expect(server.objects.has("reports/b/ok.pdf")).toBe(true);
  });

  it("retries transient failures (5xx, 429) and then succeeds", async () => {
    const storage = supabaseProvider();
    server.failNext = [503, 429];
    await storage.put("runs/r/p/x.png", bytes("png"));
    expect(server.requests.filter((r) => r.method === "POST")).toHaveLength(3);
    expect(text(await storage.get("runs/r/p/x.png"))).toBe("png");
  });

  it("gives up after three transient failures with a sanitized error, and never retries client errors", async () => {
    const storage = supabaseProvider();
    server.failNext = [503, 503, 503];
    const error = await storage.put("runs/r/p/x.png", bytes("png")).catch((e: Error) => e);
    expect(error).toBeInstanceOf(StorageOperationError);
    expect((error as Error).message).toBe("Storage upload failed for runs/r/p/x.png (HTTP 503)");
    expect((error as Error).message).not.toContain(SECRET);
    expect((error as Error).message).not.toContain(server.url);
    expect(server.objects.size).toBe(0);
    server.requests = [];
    server.failNext = [403];
    await expect(storage.get("runs/r/p/x.png")).rejects.toThrow("Storage download failed for runs/r/p/x.png (HTTP 403)");
    expect(server.requests).toHaveLength(1); // not retried
  });

  it("rejects a wrong key (403) instead of treating objects as missing", async () => {
    const storage = new SupabaseStorageProvider(createSupabaseBucket(server.url, "sb_secret_wrong_key_000000000000", BUCKET), { maxObjectBytes: 1024, retryDelayMs: 1 });
    await expect(storage.get("runs/r/p/x.png")).rejects.toThrow(/HTTP 403/);
    await expect(storage.put("runs/r/p/x.png", bytes("x"))).rejects.toThrow(/HTTP 403/);
  });

  it("reports an unreachable server as a network error after retrying", async () => {
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const storage = new SupabaseStorageProvider(createSupabaseBucket(`http://127.0.0.1:${port}`, SECRET, BUCKET), { maxObjectBytes: 1024, retryDelayMs: 1 });
    await expect(storage.get("runs/r/p/x.png")).rejects.toThrow("Storage download failed for runs/r/p/x.png (network error)");
  });
});

describe("Supabase Storage: paging and partial failures (in-memory bucket)", () => {
  /** An in-memory bucket that pages list results like Supabase. */
  function memoryBucket(keys: string[]): StorageBucketApi & { removeCalls: number } {
    const objects = new Set(keys);
    const api = {
      removeCalls: 0,
      upload: async () => ({ data: {}, error: null }),
      download: async () => ({ data: null, error: { status: 400, statusCode: "404", message: "Object not found" } }),
      exists: async (p: string) => ({ data: objects.has(p), error: null }),
      remove: async (paths: string[]) => {
        api.removeCalls++;
        return { data: paths.filter((p) => objects.delete(p)).map((name) => ({ name })), error: null };
      },
      list: async (folder: string, { limit, offset }: { limit: number; offset: number }) => {
        const names = new Map<string, string | null>();
        for (const k of objects) {
          if (!k.startsWith(`${folder}/`)) continue;
          const [first, ...more] = k.slice(folder.length + 1).split("/");
          names.set(first, more.length ? null : `id-${first}`);
        }
        return { data: [...names].sort().slice(offset, offset + limit).map(([name, id]) => ({ name, id })), error: null };
      },
    };
    return api;
  }

  it("deletes more objects than one list page or remove batch holds", async () => {
    const keys = [...Array.from({ length: 2500 }, (_, i) => `runs/r1/p/shot-${String(i).padStart(4, "0")}.png`), "runs/r1/other/a.png", "runs/r2/keep.png"];
    const bucket = memoryBucket(keys);
    const storage = new SupabaseStorageProvider(bucket, { maxObjectBytes: 1024 });
    expect(await storage.deletePrefix("runs/r1")).toBe(2501);
    expect(bucket.removeCalls).toBe(3); // batches of 1000
    expect(await storage.exists("runs/r2/keep.png")).toBe(true);
  });

  it("treats both forms of Supabase 'not found' as missing", async () => {
    for (const error of [{ status: 404, message: "Not Found" }, { status: 400, statusCode: "404", message: "Object not found" }, { status: 400, statusCode: "not_found", message: "x" }]) {
      const storage = new SupabaseStorageProvider({ ...memoryBucket([]), download: async () => ({ data: null, error }) }, { maxObjectBytes: 1 });
      expect(await storage.get("runs/x.png"), JSON.stringify(error)).toBeNull();
    }
  });
});

describe("storage selection", () => {
  const supabaseEnv = (extra: Record<string, string> = {}) => readEnv({ STORAGE_PROVIDER: "supabase", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SECRET_KEY: SECRET, ...extra });
  const jwt = (role: string) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig`;
  afterEach(() => vi.restoreAllMocks());

  it("uses local files by default", () => {
    expect(readEnv({}).STORAGE_PROVIDER).toBe("local");
    expect(createStorageProvider(readEnv({})).kind).toBe("local-filesystem");
  });

  it("uses the private Supabase bucket only when selected, with the configured bucket and size limit", () => {
    const factory = vi.fn(() => ({}) as StorageBucketApi);
    const storage = createStorageProvider(supabaseEnv({ STORAGE_MAX_OBJECT_MB: "2" }), factory);
    expect(storage.kind).toBe("supabase-storage");
    expect(factory).toHaveBeenCalledWith("https://abc.supabase.co", SECRET, "qa-pilot-artifacts");
    expect(supabaseStorageConfig(supabaseEnv({ STORAGE_MAX_OBJECT_MB: "2" })).maxObjectBytes).toBe(2 * 1024 * 1024);
    expect(supabaseStorageConfig({ ...supabaseEnv({ SUPABASE_URL: "" }), NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co/" }).url).toBe("https://abc.supabase.co");
    expect(supabaseStorageConfig(supabaseEnv({ SUPABASE_SECRET_KEY: "", SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") })).key).toBe(jwt("service_role"));
  });

  it("fails clearly, never falling back to local files, and never echoes the key", () => {
    const factory = vi.fn();
    const cases: [Record<string, string>, RegExp][] = [
      [{ SUPABASE_URL: "" }, /requires SUPABASE_URL/],
      [{ SUPABASE_URL: "not a url" }, /not a valid URL/],
      [{ SUPABASE_URL: "http://abc.supabase.co" }, /must use https/],
      [{ SUPABASE_SECRET_KEY: "" }, /requires SUPABASE_SECRET_KEY/],
      [{ SUPABASE_SECRET_KEY: "sb_publishable_abcdefghijklmnop" }, /not the publishable\/anon key/],
      [{ SUPABASE_SECRET_KEY: jwt("anon") }, /not the publishable\/anon key/],
      [{ STORAGE_BUCKET: "Bad_Bucket!" }, /not a valid bucket name/],
    ];
    for (const [extra, message] of cases) {
      let error: unknown;
      try {
        createStorageProvider(supabaseEnv(extra), factory);
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(extra)).toBeInstanceOf(StorageConfigurationError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain("sb_");
    }
    expect(factory).not.toHaveBeenCalled();
    expect(() => readEnv({ STORAGE_PROVIDER: "s3" })).toThrow(/STORAGE_PROVIDER/);
  });
});
