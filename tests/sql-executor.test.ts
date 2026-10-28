import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IN_MEMORY, openSqlite, runMigrations, type SqliteDatabase } from "@/lib/database/local/sqlite-client";
import { SqliteExecutor } from "@/lib/database/sql/sqlite-executor";

/** SqliteExecutor: same results as direct better-sqlite3 calls, plus async-safe transactions. In-memory only. */

let db: SqliteDatabase;
let sql: SqliteExecutor;

beforeEach(() => {
  db = openSqlite(IN_MEMORY);
  runMigrations(db);
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL, note TEXT)");
  sql = new SqliteExecutor(db);
});
afterEach(() => db.close());

const count = () => (db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("queries", () => {
  it("returns exactly what direct better-sqlite3 calls return", async () => {
    expect(await sql.run("INSERT INTO t (id, n, note) VALUES (?, ?, ?)", ["a", 1, null])).toEqual({ changes: 1 });
    await sql.run("INSERT INTO t (id, n, note) VALUES (?, ?, ?)", ["b", 2, "x"]);
    const q = "SELECT id, n, note FROM t WHERE n >= ? ORDER BY id";
    expect(await sql.all(q, [1])).toEqual(db.prepare(q).all(1));
    expect(await sql.get(q, [2])).toEqual(db.prepare(q).get(2));
    expect(await sql.get(q, [99])).toBeUndefined();
    expect(await sql.all(q, [99])).toEqual([]);
    expect(await sql.run("UPDATE t SET n = n + 1", [])).toEqual({ changes: 2 });
    expect(await sql.run("DELETE FROM t WHERE id = ?", ["missing"])).toEqual({ changes: 0 });
    // Reused (cached) statements still bind fresh parameters.
    expect(await sql.get<{ id: string }>("SELECT id FROM t WHERE id = ?", ["a"])).toEqual({ id: "a" });
    expect(await sql.get<{ id: string }>("SELECT id FROM t WHERE id = ?", ["b"])).toEqual({ id: "b" });
  });

  it("works on the migrated application schema with foreign keys enforced", async () => {
    expect(await sql.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations")).toEqual({ v: 7 });
    await expect(sql.run("INSERT INTO documents (id, project_id, kind, file_name, mime_type, size_bytes, storage_key, checksum_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["d", "no-such-project", "REFERENCE", "f", "m", 1, "k", "x"])).rejects.toThrow(/FOREIGN KEY/);
  });

  it("reports SQL errors as rejected promises", async () => {
    await expect(sql.all("SELECT * FROM no_such_table")).rejects.toThrow(/no such table/);
    await expect(sql.run("INSERT INTO t (id, n) VALUES (?, ?)", ["a", null])).rejects.toThrow(/NOT NULL/);
  });
});

describe("transactions", () => {
  it("commits when the callback resolves and returns its value", async () => {
    const value = await sql.transaction(async (tx) => {
      await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", ["a", 1]);
      await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", ["b", 2]);
      return "done";
    });
    expect(value).toBe("done");
    expect(count()).toBe(2);
    expect(db.inTransaction).toBe(false);
  });

  it("rolls back everything when the callback throws, and stays usable", async () => {
    await expect(
      sql.transaction(async (tx) => {
        await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", ["a", 1]);
        await tick();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(count()).toBe(0);
    expect(db.inTransaction).toBe(false);
    // A failing statement inside also rolls back the earlier ones.
    await expect(
      sql.transaction(async (tx) => {
        await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", ["a", 1]);
        await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", ["a", 2]); // duplicate key
      }),
    ).rejects.toThrow(/UNIQUE/);
    expect(count()).toBe(0);
    await sql.run("INSERT INTO t (id, n) VALUES (?, ?)", ["z", 1]);
    expect(count()).toBe(1);
  });

  it("turns nested transactions into savepoints", async () => {
    await sql.transaction(async (tx) => {
      await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", ["outer", 1]);
      await expect(
        tx.transaction(async (inner) => {
          await inner.run("INSERT INTO t (id, n) VALUES (?, ?)", ["inner-1", 1]);
          throw new Error("inner failed");
        }),
      ).rejects.toThrow("inner failed");
      await tx.transaction(async (inner) => inner.run("INSERT INTO t (id, n) VALUES (?, ?)", ["inner-2", 1]));
    });
    expect((db.prepare("SELECT id FROM t ORDER BY id").all() as { id: string }[]).map((r) => r.id)).toEqual(["inner-2", "outer"]);
  });

  it("serializes concurrent transactions instead of interleaving them", async () => {
    const order: string[] = [];
    const work = (name: string) =>
      sql.transaction(async (tx) => {
        order.push(`${name}:start`);
        await tick();
        await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", [name, 1]);
        await tick();
        order.push(`${name}:end`);
      });
    await Promise.all([work("a"), work("b"), work("c")]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
    expect(count()).toBe(3);
  });

  it("makes other async flows wait instead of seeing uncommitted rows", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tx = sql.transaction(async (t) => {
      await t.run("INSERT INTO t (id, n) VALUES (?, ?)", ["pending", 1]);
      await gate;
      throw new Error("abort");
    });
    await tick();
    const read = sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM t"); // another flow
    let settled = false;
    void read.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false); // blocked while the transaction is open
    release();
    await expect(tx).rejects.toThrow("abort");
    expect(await read).toEqual({ c: 0 }); // saw only committed state
  });

  it("lets code inside a transaction use the executor itself without deadlocking", async () => {
    await sql.transaction(async () => {
      await sql.run("INSERT INTO t (id, n) VALUES (?, ?)", ["via-outer", 1]);
      expect(await sql.get("SELECT id FROM t WHERE id = ?", ["via-outer"])).toEqual({ id: "via-outer" });
    });
    expect(count()).toBe(1);
  });
});
