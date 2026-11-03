import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import { createTestDb } from "./helpers";

/**
 * Worker repository: `status` (in-memory SQLite only). Pins the empty result, liveness against the stale window,
 * handler parsing, and which heartbeat is reported when there are several, so the method can move onto the SQL
 * executor unchanged. Heartbeats are seeded directly.
 *
 * Ties: the query orders by `last_seen_at DESC LIMIT 1` with no tie-break, so when several heartbeats share the newest
 * timestamp SQLite does not guarantee which one is returned. The tests only assert that the result is one of the tied
 * heartbeats, never which one.
 *
 * Set QA_WORKER_BEHAVIOUR_OUT to a file path to also write the observations as JSON (used to compare the
 * implementation before and after a refactor).
 */

const NOW = "2026-03-10T12:00:00.000Z";
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const OFFLINE = { online: false, lastSeenAt: null, handlers: [] };

let base: LocalDatabaseProvider;

function heartbeat(workerId: string, lastSeenAt: string, handlers: string | string[]) {
  base.sqlite
    .prepare("INSERT INTO worker_heartbeats (worker_id, hostname, pid, handlers, started_at, last_seen_at) VALUES (?, 'host', 1, ?, ?, ?)")
    .run(workerId, typeof handlers === "string" ? handlers : JSON.stringify(handlers), ago(3_600_000), lastSeenAt);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  base = createTestDb();
});
afterEach(async () => {
  vi.useRealTimers();
  await base.close();
});

describe("worker repository: status", () => {
  it("reports offline with no heartbeat records", async () => {
    expect(await base.workers.status()).toEqual(OFFLINE);
    expect(await base.workers.status(60_000)).toEqual(OFFLINE);
  });

  it("reports a single heartbeat, online only within the stale window", async () => {
    heartbeat("w1", ago(5_000), ["run.execute", "crawl.execute"]);
    expect(await base.workers.status()).toEqual({ online: true, lastSeenAt: ago(5_000), handlers: ["run.execute", "crawl.execute"] });
    expect((await base.workers.status(5_000)).online).toBe(false); // exactly at the window: stale
    expect((await base.workers.status(5_001)).online).toBe(true);
    expect((await base.workers.status(0)).online).toBe(false);
  });

  it("keeps the existing edge cases for a single heartbeat", async () => {
    heartbeat("w1", ago(20_000), "not json");
    expect(await base.workers.status()).toEqual({ online: false, lastSeenAt: ago(20_000), handlers: [] }); // stale; bad JSON → []
    expect((await base.workers.status(60_000)).online).toBe(true);
  });

  it("reports the most recent of several heartbeats, whatever the insertion order", async () => {
    heartbeat("old", ago(60_000), ["old"]);
    heartbeat("newest", ago(1_000), ["newest"]);
    heartbeat("middle", ago(10_000), ["middle"]);
    expect(await base.workers.status()).toEqual({ online: true, lastSeenAt: ago(1_000), handlers: ["newest"] });
  });

  it("reports one of the heartbeats tied on the newest timestamp, without relying on which", async () => {
    heartbeat("older", ago(30_000), ["older"]);
    heartbeat("tie-a", ago(2_000), ["tie-a"]);
    heartbeat("tie-b", ago(2_000), ["tie-b"]);
    const status = await base.workers.status();
    expect(status.lastSeenAt).toBe(ago(2_000));
    expect(status.online).toBe(true);
    // The SQL has no tie-break: either tied heartbeat is a valid result, an older one never is.
    expect([["tie-a"], ["tie-b"]]).toContainEqual(status.handlers);
  });

  it("is the same through the owner-scoped provider (worker liveness holds no user data)", async () => {
    heartbeat("w1", ago(5_000), ["run.execute"]);
    expect(await new OwnerScopedDatabaseProvider(base, "user-alice").workers.status()).toEqual(await base.workers.status());
  });

  it("produces the recorded behaviour snapshot", async () => {
    const out: Record<string, unknown> = { empty: await base.workers.status() };
    heartbeat("w1", ago(20_000), ["a"]);
    out.single = await base.workers.status();
    out.singleWide = await base.workers.status(60_000);
    heartbeat("w2", ago(4_000), "not json");
    out.newest = await base.workers.status();
    out.newestNarrow = await base.workers.status(4_000);
    heartbeat("w3", ago(4_000), ["tied"]);
    // Recorded for the before/after comparison only (same SQL and data on the same engine); not asserted, because the
    // SQL does not define which tied row wins.
    out.tieObserved = await base.workers.status();
    if (process.env.QA_WORKER_BEHAVIOUR_OUT) fs.writeFileSync(process.env.QA_WORKER_BEHAVIOUR_OUT, JSON.stringify(out, null, 2));
    expect(out.empty).toEqual(OFFLINE);
  });
});
