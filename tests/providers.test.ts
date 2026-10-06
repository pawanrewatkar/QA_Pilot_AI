import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalAnalysisProvider } from "@/lib/ai/local-analysis-provider";
import { readEnv } from "@/lib/config/env";
import { LocalOutboxEmailProvider } from "@/lib/email/local-outbox-provider";
import { getProviderStatuses } from "@/lib/providers/status";
import { LocalStorageProvider } from "@/lib/storage/local-storage-provider";
import { InvalidStorageKeyError } from "@/lib/storage/provider";
import { SqliteJobQueue } from "@/worker/jobs/job-queue";
import { createTestDb, makeTempDir } from "./helpers";

describe("LocalStorageProvider", () => {
  let root: string;
  let storage: LocalStorageProvider;
  beforeEach(() => {
    root = makeTempDir();
    storage = new LocalStorageProvider(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("puts, gets, checks and deletes objects", async () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(await storage.put("a/b/c.bin", data)).toEqual({ key: "a/b/c.bin", sizeBytes: 3 });
    expect(await storage.exists("a/b/c.bin")).toBe(true);
    expect(await storage.get("a/b/c.bin")).toEqual(data);
    expect(await storage.delete("a/b/c.bin")).toBe(true);
    expect(await storage.get("a/b/c.bin")).toBeNull();
    expect(await storage.delete("a/b/c.bin")).toBe(false);
  });

  it("deletes by prefix", async () => {
    await storage.put("p/1/x.txt", new Uint8Array([1]));
    await storage.put("p/1/y/z.txt", new Uint8Array([1]));
    await storage.put("p/2/x.txt", new Uint8Array([1]));
    expect(await storage.deletePrefix("p/1")).toBe(2);
    expect(await storage.exists("p/2/x.txt")).toBe(true);
    expect(await storage.deletePrefix("nothing/here")).toBe(0);
  });

  it.each(["../escape.txt", "/abs.txt", "a/../../b", "a\\b", "a//b", ".hidden", ""])("rejects unsafe key %j", async (key) => {
    await expect(storage.put(key, new Uint8Array([1]))).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });
});

describe("LocalAnalysisProvider", () => {
  const ai = new LocalAnalysisProvider();

  it("is local-only", () => {
    expect(ai.external).toBe(false);
    expect(ai.capabilities.has("scenario-generation")).toBe(false);
  });

  it("derives a bug title from the observation only", async () => {
    const s = await ai.suggestBugTitle({ module: "links", status: "FAIL", message: "Link returned 404", pageUrl: "https://example.com/about?x=1" });
    expect(s.value).toBe("[Link] Link returned 404 on /about");
  });

  it("suggests severity deterministically", async () => {
    expect((await ai.suggestSeverity({ module: "links", status: "FAIL", message: "x", httpStatus: 503 })).value).toBe("CRITICAL");
    expect((await ai.suggestSeverity({ module: "login", status: "FAIL", message: "x" })).value).toBe("HIGH");
    expect((await ai.suggestSeverity({ module: "links", status: "FAIL", message: "x", httpStatus: 404 })).value).toBe("MEDIUM");
    expect((await ai.suggestSeverity({ module: "seo", status: "WARNING", message: "x" })).value).toBe("LOW");
  });

  it("detects duplicates by fingerprint and title similarity", async () => {
    const matches = await ai.findDuplicateBugs({ title: "Broken link on the about page" }, [
      { id: "1", title: "Broken link on about page" },
      { id: "2", title: "Checkout button overlaps footer" },
      { id: "3", title: "unrelated", fingerprint: "fp" },
    ]);
    expect(matches.map((m) => m.id)).toEqual(["1"]);
    const byFp = await ai.findDuplicateBugs({ title: "x", fingerprint: "fp" }, [{ id: "3", title: "unrelated", fingerprint: "fp" }]);
    expect(byFp).toEqual([{ id: "3", score: 1, reason: "fingerprint" }]);
  });

  it("summarizes only the counts it is given", async () => {
    expect((await ai.summarizeResults({ pass: 0, fail: 0, warning: 0, notExecuted: 0, notApplicable: 0 })).value).toBe("No test results have been recorded.");
    expect((await ai.summarizeResults({ pass: 3, fail: 1, warning: 0, notExecuted: 2, notApplicable: 0 })).value).toBe(
      "4 of 6 checks executed, 75% pass rate, 1 failed, 0 warnings, 2 not executed.",
    );
  });

  it("makes no root-cause claim without a matching pattern", async () => {
    expect((await ai.suggestRootCause({ module: "ui", status: "FAIL", message: "Something odd" })).value).toBeNull();
  });

  it("compares text", async () => {
    const c = await ai.compareText("Welcome to our store", "Welcome to the store");
    expect(c.missingWords).toEqual(["our"]);
    expect(c.extraWords).toEqual(["the"]);
    expect(c.similarity).toBeGreaterThan(0.5);
  });
});

describe("provider status", () => {
  it("runs fully local with no environment configured", () => {
    const statuses = getProviderStatuses(readEnv({}));
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s]));
    expect(byId.ai.state).toBe("LOCAL");
    expect(byId.database).toMatchObject({ state: "LOCAL", availability: "ACTIVE" });
    expect(byId.storage.state).toBe("LOCAL");
    expect(byId.figma.state).toBe("NOT_CONFIGURED");
    expect(byId.email).toMatchObject({ state: "LOCAL", availability: "ACTIVE" });
    expect(statuses.map((s) => s.id)).toEqual(expect.arrayContaining(["ai", "database", "storage", "figma", "performance", "email"]));
  });

  it("never exposes secret values", () => {
    const secret = "super-secret-token-value";
    const json = JSON.stringify(getProviderStatuses(readEnv({ FIGMA_ACCESS_TOKEN: secret, ANTHROPIC_API_KEY: secret, PAGESPEED_API_KEY: secret })));
    expect(json).not.toContain(secret);
    expect(json).toContain("CONFIGURED");
  });

  it("treats blank env values as unset and rejects invalid ones", () => {
    expect(readEnv({ DATABASE_PATH: "  " }).DATABASE_PATH).toBe("./data/qa-pilot.db");
    expect(() => readEnv({ DATABASE_PROVIDER: "mysql" })).toThrow(/Invalid environment/);
  });
});

describe("LocalOutboxEmailProvider", () => {
  it("writes messages to local storage instead of sending", async () => {
    const root = makeTempDir();
    const storage = new LocalStorageProvider(root);
    const email = new LocalOutboxEmailProvider(storage);
    const result = await email.send({ to: ["qa@example.com"], subject: "Report", text: "Done" });
    expect(email.deliversExternally).toBe(false);
    expect(JSON.parse(new TextDecoder().decode((await storage.get(result.destination))!))).toMatchObject({ subject: "Report" });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("SqliteJobQueue", () => {
  it("claims atomically, retries with backoff and fails after max attempts", async () => {
    const db = createTestDb();
    const queue = new SqliteJobQueue(db.sqlite);
    const job = queue.enqueue("crawl.project", { projectId: "p" }, { maxAttempts: 2 });

    expect(queue.claim("w1", [])).toBeNull();
    expect(queue.claim("w1", ["report.generate"])).toBeNull();
    const claimed = queue.claim("w1", ["crawl.project"]);
    expect(claimed).toMatchObject({ id: job.id, status: "RUNNING", attempts: 1 });
    expect(queue.claim("w2", ["crawl.project"])).toBeNull();

    expect(queue.fail(job.id, "boom")).toMatchObject({ status: "PENDING", lastError: "boom" });
    db.sqlite.prepare("UPDATE jobs SET run_after = ? WHERE id = ?").run(new Date(0).toISOString(), job.id);
    queue.claim("w1", ["crawl.project"]);
    expect(queue.fail(job.id, "boom again")).toMatchObject({ status: "FAILED", attempts: 2 });
    await db.close();
  });
});
