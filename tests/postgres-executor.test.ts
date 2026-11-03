import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readEnv } from "@/lib/config/env";
import { createDatabaseProvider } from "@/lib/database";
import { PostgresExecutor, postgresPoolConfig, toPostgresPlaceholders, type PgClientLike, type PgPoolLike } from "@/lib/database/sql/postgres-executor";
import { DatabaseConfigurationError, postgresConfig, selectSqlExecutor } from "@/lib/database/sql/select-executor";
import { SqliteExecutor } from "@/lib/database/sql/sqlite-executor";

/**
 * PostgresExecutor and executor selection, with a fake `pg` pool (no database, no network). The fake records every
 * statement with the connection it ran on, so tests can check placeholder translation, bound values, which client a
 * transaction uses, rollback and release.
 */

type Result = { rows: unknown[]; rowCount: number | null };
type Handler = (text: string, values: unknown[] | undefined, on: string) => Result | Error | undefined;

function fakePool(handler: Handler = () => undefined) {
  const log: { on: string; text: string; values?: unknown[] }[] = [];
  const released: { client: string; error?: Error }[] = [];
  let clients = 0;
  let ended = false;
  const queryOn = (on: string) => async (text: string, values?: unknown[]) => {
    log.push(values === undefined ? { on, text } : { on, text, values });
    await Promise.resolve(); // behave like real I/O: resolve asynchronously
    const r = handler(text, values, on);
    if (r instanceof Error) throw r;
    return r ?? { rows: [], rowCount: 0 };
  };
  const pool: PgPoolLike & { connectError?: Error } = {
    query: queryOn("pool"),
    connect: async () => {
      if (pool.connectError) throw pool.connectError;
      const name = `client${++clients}`;
      const client: PgClientLike = { query: queryOn(name), release: (error?: Error) => void released.push(error ? { client: name, error } : { client: name }) };
      return client;
    },
    end: async () => void (ended = true),
  };
  return { pool, log, released, ended: () => ended };
}

const statements = (log: { on: string; text: string }[]) => log.map((l) => `${l.on}: ${l.text}`);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("placeholder translation", () => {
  it("numbers positional placeholders in order", () => {
    expect(toPostgresPlaceholders("SELECT * FROM t WHERE a = ? AND b IN (?, ?) LIMIT ?")).toEqual({ text: "SELECT * FROM t WHERE a = $1 AND b IN ($2, $3) LIMIT $4", count: 4 });
    expect(toPostgresPlaceholders("SELECT 1")).toEqual({ text: "SELECT 1", count: 0 });
  });

  it("leaves ? alone inside literals, quoted identifiers, dollar quotes and comments", () => {
    const sql = [
      "SELECT '?', 'it''s ?', E'\\' ?', \"col?\", \"a\"\"?\" FROM t",
      "WHERE x = ? -- trailing ? comment",
      "AND y = ? /* block ? /* nested ? */ still ? */ AND z = $$ ? $$ AND w = $tag$ ? 'x' $tag$ AND v = ?",
    ].join("\n");
    const { text, count } = toPostgresPlaceholders(sql);
    expect(count).toBe(3);
    expect(text).toBe(sql.replace("x = ?", "x = $1").replace("y = ?", "y = $2").replace("v = ?", "v = $3"));
  });

  it("handles the SQL the repositories use: LIKE … ESCAPE '\\' and existing $n / $ in identifiers", () => {
    expect(toPostgresPlaceholders("WHERE (a LIKE ? ESCAPE '\\' OR b LIKE ? ESCAPE '\\') AND c = ?").text).toBe("WHERE (a LIKE $1 ESCAPE '\\' OR b LIKE $2 ESCAPE '\\') AND c = $3");
    expect(toPostgresPlaceholders("SELECT a$b$ FROM t WHERE x = ?").text).toBe("SELECT a$b$ FROM t WHERE x = $1");
    expect(toPostgresPlaceholders("SELECT $1, ?").text).toBe("SELECT $1, $1"); // `$n` is not touched; mixing styles is not supported
  });

  it("does not hang or lose text on unterminated literals and comments", () => {
    for (const sql of ["SELECT 'open ?", 'SELECT "open ?', "SELECT 1 /* open ?", "SELECT $$ open ?"]) expect(toPostgresPlaceholders(sql)).toEqual({ text: sql, count: 0 });
  });
});

describe("PostgresExecutor: statements", () => {
  it("binds values in order with translated placeholders, converting bigint to text", async () => {
    const { pool, log } = fakePool((text) => (text.startsWith("SELECT") ? { rows: [{ id: "a" }, { id: "b" }], rowCount: 2 } : { rows: [], rowCount: 3 }));
    const sql = new PostgresExecutor(pool);
    const buf = Buffer.from([1, 2]);
    expect(await sql.all("SELECT id FROM t WHERE a = ? AND b = ?", ["x", 1])).toEqual([{ id: "a" }, { id: "b" }]);
    expect(await sql.get("SELECT id FROM t WHERE c = ?", [9007199254740993n])).toEqual({ id: "a" });
    expect(await sql.run("UPDATE t SET d = ?, e = ? WHERE f = ?", [null, buf, "y"])).toEqual({ changes: 3 });
    expect(log).toEqual([
      { on: "pool", text: "SELECT id FROM t WHERE a = $1 AND b = $2", values: ["x", 1] },
      { on: "pool", text: "SELECT id FROM t WHERE c = $1", values: ["9007199254740993"] },
      { on: "pool", text: "UPDATE t SET d = $1, e = $2 WHERE f = $3", values: [null, buf, "y"] },
    ]);
    expect(sql.dialect).toBe("postgres");
  });

  it("returns undefined for no row and 0 changes when the driver reports none", async () => {
    const { pool } = fakePool(() => ({ rows: [], rowCount: null }));
    const sql = new PostgresExecutor(pool);
    expect(await sql.get("SELECT 1")).toBeUndefined();
    expect(await sql.all("SELECT 1")).toEqual([]);
    expect(await sql.run("DELETE FROM t")).toEqual({ changes: 0 });
  });

  it("rejects a parameter count mismatch before sending anything", async () => {
    const { pool, log } = fakePool();
    const sql = new PostgresExecutor(pool);
    await expect(sql.all("SELECT ? , ?", ["only one"])).rejects.toThrow(RangeError);
    await expect(sql.run("DELETE FROM t", ["extra"])).rejects.toThrow("Expected 0 parameter value(s) but received 1");
    expect(log).toEqual([]);
  });

  it("propagates driver errors unchanged", async () => {
    const failure = Object.assign(new Error('relation "t" does not exist'), { code: "42P01" });
    const { pool } = fakePool(() => failure);
    const sql = new PostgresExecutor(pool);
    await expect(sql.get("SELECT * FROM t")).rejects.toBe(failure);
  });

  it("closes the pool", async () => {
    const fake = fakePool();
    await new PostgresExecutor(fake.pool).close();
    expect(fake.ended()).toBe(true);
  });
});

describe("PostgresExecutor: transactions", () => {
  it("runs every statement of a transaction on one client, commits and releases it", async () => {
    const { pool, log, released } = fakePool();
    const sql = new PostgresExecutor(pool);
    const value = await sql.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (?)", ["a"]);
      await sql.run("INSERT INTO t VALUES (?)", ["b"]); // the executor itself joins the transaction too
      return "done";
    });
    expect(value).toBe("done");
    expect(statements(log)).toEqual(["client1: BEGIN", "client1: INSERT INTO t VALUES ($1)", "client1: INSERT INTO t VALUES ($1)", "client1: COMMIT"]);
    expect(released).toEqual([{ client: "client1" }]);
    await sql.run("DELETE FROM t");
    expect(log.at(-1)).toEqual({ on: "pool", text: "DELETE FROM t", values: [] }); // back on the pool afterwards
  });

  it("rolls back and rethrows the original error when the callback throws", async () => {
    const { pool, log, released } = fakePool();
    const sql = new PostgresExecutor(pool);
    const failure = new Error("boom");
    await expect(
      sql.transaction(async (tx) => {
        await tx.run("INSERT INTO t VALUES (?)", ["a"]);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(statements(log)).toEqual(["client1: BEGIN", "client1: INSERT INTO t VALUES ($1)", "client1: ROLLBACK"]);
    expect(released).toEqual([{ client: "client1" }]);
  });

  it("rolls back when a statement fails", async () => {
    const failure = new Error("duplicate key");
    const { pool, log, released } = fakePool((text) => (text.startsWith("INSERT") ? failure : undefined));
    const sql = new PostgresExecutor(pool);
    await expect(sql.transaction((tx) => tx.run("INSERT INTO t VALUES (?)", ["a"]))).rejects.toBe(failure);
    expect(statements(log)).toEqual(["client1: BEGIN", "client1: INSERT INTO t VALUES ($1)", "client1: ROLLBACK"]);
    expect(released).toEqual([{ client: "client1" }]);
  });

  it("reports a failed COMMIT and still releases the client", async () => {
    const failure = new Error("could not serialize access");
    const { pool, log, released } = fakePool((text) => (text === "COMMIT" ? failure : undefined));
    const sql = new PostgresExecutor(pool);
    await expect(sql.transaction(async () => "x")).rejects.toBe(failure);
    expect(statements(log)).toEqual(["client1: BEGIN", "client1: COMMIT", "client1: ROLLBACK"]);
    expect(released).toEqual([{ client: "client1" }]);
  });

  it("destroys the client when ROLLBACK fails, and reports the original error", async () => {
    const original = new Error("statement failed");
    const rollbackFailure = new Error("connection terminated");
    const { pool, released } = fakePool((text) => (text === "ROLLBACK" ? rollbackFailure : text.startsWith("INSERT") ? original : undefined));
    const sql = new PostgresExecutor(pool);
    await expect(sql.transaction((tx) => tx.run("INSERT INTO t VALUES (1)"))).rejects.toBe(original);
    expect(released).toEqual([{ client: "client1", error: rollbackFailure }]);
  });

  it("destroys the client when BEGIN fails, without running the callback", async () => {
    const failure = new Error("connection reset");
    const { pool, released } = fakePool((text) => (text === "BEGIN" ? failure : undefined));
    const sql = new PostgresExecutor(pool);
    const fn = vi.fn(async () => "x");
    await expect(sql.transaction(fn)).rejects.toBe(failure);
    expect(fn).not.toHaveBeenCalled();
    expect(released).toEqual([{ client: "client1", error: failure }]);
  });

  it("propagates a failure to connect, without running the callback or releasing anything", async () => {
    const fake = fakePool();
    fake.pool.connectError = new Error("too many clients");
    const sql = new PostgresExecutor(fake.pool);
    const fn = vi.fn(async () => "x");
    await expect(sql.transaction(fn)).rejects.toBe(fake.pool.connectError);
    expect(fn).not.toHaveBeenCalled();
    expect(fake.released).toEqual([]);
  });

  it("turns nested transactions into savepoints on the same client, rolling back only the failed one", async () => {
    const { pool, log, released } = fakePool();
    const sql = new PostgresExecutor(pool);
    await sql.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES ('outer')");
      await tx.transaction(async (inner) => {
        await inner.run("INSERT INTO t VALUES ('kept')");
        await inner.transaction((deeper) => deeper.run("INSERT INTO t VALUES ('deeper')"));
      });
      await expect(
        tx.transaction(async (inner) => {
          await inner.run("INSERT INTO t VALUES ('undone')");
          throw new Error("inner failure");
        }),
      ).rejects.toThrow("inner failure");
    });
    expect(statements(log)).toEqual([
      "client1: BEGIN",
      "client1: INSERT INTO t VALUES ('outer')",
      "client1: SAVEPOINT qa_sp_1",
      "client1: INSERT INTO t VALUES ('kept')",
      "client1: SAVEPOINT qa_sp_2",
      "client1: INSERT INTO t VALUES ('deeper')",
      "client1: RELEASE SAVEPOINT qa_sp_2",
      "client1: RELEASE SAVEPOINT qa_sp_1",
      "client1: SAVEPOINT qa_sp_1",
      "client1: INSERT INTO t VALUES ('undone')",
      "client1: ROLLBACK TO SAVEPOINT qa_sp_1",
      "client1: RELEASE SAVEPOINT qa_sp_1",
      "client1: COMMIT",
    ]);
    expect(released).toEqual([{ client: "client1" }]);
  });

  it("keeps other async flows off the transaction's client, and gives concurrent transactions their own clients", async () => {
    const { pool, log, released } = fakePool();
    const sql = new PostgresExecutor(pool);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    const first = sql.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES ('first')");
      await gate;
      await tx.run("INSERT INTO t VALUES ('first again')");
    });
    await vi.waitFor(() => expect(statements(log)).toContain("client1: INSERT INTO t VALUES ('first')"));
    await sql.get("SELECT 'outside'"); // another flow, while the transaction is open
    const second = sql.transaction((tx) => tx.run("INSERT INTO t VALUES ('second')"));
    await second;
    unblock();
    await first;
    expect(statements(log).filter((s) => s.startsWith("pool"))).toEqual(["pool: SELECT 'outside'"]);
    expect(statements(log).filter((s) => s.startsWith("client2"))).toEqual(["client2: BEGIN", "client2: INSERT INTO t VALUES ('second')", "client2: COMMIT"]);
    expect(statements(log).filter((s) => s.startsWith("client1"))).toEqual(["client1: BEGIN", "client1: INSERT INTO t VALUES ('first')", "client1: INSERT INTO t VALUES ('first again')", "client1: COMMIT"]);
    expect(released.map((r) => r.client).sort()).toEqual(["client1", "client2"]);
  });
});

describe("executor selection", () => {
  const URL = "postgresql://user:s3cret-pass@127.0.0.1:1/qa";

  it("uses SQLite by default", () => {
    expect(readEnv({}).DATABASE_PROVIDER).toBe("local");
    const db = new Database(":memory:");
    const open = vi.fn(() => db);
    const sql = selectSqlExecutor(readEnv({}), open);
    expect(sql).toBeInstanceOf(SqliteExecutor);
    expect(sql.dialect).toBe("sqlite");
    expect(open).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("uses PostgreSQL only when selected explicitly, without opening SQLite or connecting", () => {
    const fake = fakePool();
    const createPool = vi.fn(() => fake.pool);
    const open = vi.fn();
    const sql = selectSqlExecutor(readEnv({ DATABASE_PROVIDER: "supabase", DATABASE_URL: URL }), open, createPool);
    expect(sql).toBeInstanceOf(PostgresExecutor);
    expect(createPool).toHaveBeenCalledWith(URL, { max: 5, connectionTimeoutMillis: 10_000, queryTimeoutMillis: 30_000, sslCa: undefined });
    expect(open).not.toHaveBeenCalled();
    expect(fake.log).toEqual([]);
  });

  it("never falls back to SQLite when PostgreSQL is selected but not configured, and never echoes the URL", () => {
    const open = vi.fn();
    const createPool = vi.fn();
    expect(() => selectSqlExecutor(readEnv({ DATABASE_PROVIDER: "supabase" }), open, createPool)).toThrow(DatabaseConfigurationError);
    expect(() => selectSqlExecutor(readEnv({ DATABASE_PROVIDER: "supabase", DATABASE_URL: "   " }), open, createPool)).toThrow(/requires DATABASE_URL/);
    let message = "";
    try {
      selectSqlExecutor(readEnv({ DATABASE_PROVIDER: "supabase", DATABASE_URL: "mysql://user:s3cret-pass@host/db" }), open, createPool);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/postgres:\/\/ or postgresql:\/\//);
    expect(message).not.toContain("s3cret-pass");
    expect(open).not.toHaveBeenCalled();
    expect(createPool).not.toHaveBeenCalled();
  });

  it("creates a real pg pool lazily (no connection until the first query) and logs nothing", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const sql = selectSqlExecutor(readEnv({ DATABASE_PROVIDER: "supabase", DATABASE_URL: URL }), vi.fn());
    expect(sql.dialect).toBe("postgres");
    await (sql as PostgresExecutor).close();
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("opens the PostgreSQL provider for supabase, without connecting or touching SQLite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-pg-provider-"));
    const sqliteFile = path.join(dir, "must-not-exist.db");
    try {
      vi.stubEnv("DATABASE_PROVIDER", "supabase");
      vi.stubEnv("DATABASE_URL", URL);
      vi.stubEnv("DATABASE_PATH", sqliteFile);
      const provider = createDatabaseProvider();
      expect(provider.kind).toBe("supabase");
      expect((provider as unknown as { sql: { dialect: string } }).sql.dialect).toBe("postgres");
      expect(fs.existsSync(sqliteFile)).toBe(false);
      await provider.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a misconfigured PostgreSQL selection before anything else, without opening SQLite or echoing secrets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-pg-config-"));
    const sqliteFile = path.join(dir, "must-not-exist.db");
    try {
      vi.stubEnv("DATABASE_PROVIDER", "supabase");
      vi.stubEnv("DATABASE_PATH", sqliteFile);
      vi.stubEnv("DATABASE_URL", "");
      expect(() => createDatabaseProvider()).toThrow(DatabaseConfigurationError);
      vi.stubEnv("DATABASE_URL", "mysql://user:s3cret-pass@host/db");
      expect(() => createDatabaseProvider()).toThrow(/postgres:\/\/ or postgresql:\/\//);
      vi.stubEnv("DATABASE_URL", URL);
      vi.stubEnv("DATABASE_SSL_CA", "not a certificate");
      expect(() => createDatabaseProvider()).toThrow(/DATABASE_SSL_CA must contain a PEM certificate/);
      vi.stubEnv("DATABASE_SSL_CA", "");
      vi.stubEnv("DATABASE_POOL_MAX", "500");
      expect(() => createDatabaseProvider()).toThrow(/DATABASE_POOL_MAX/);
      expect(fs.existsSync(sqliteFile)).toBe(false); // never fell back to SQLite
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PostgreSQL configuration", () => {
  const URL = "postgresql://postgres.ref:p%40ss%5Dword@aws-0-region.pooler.supabase.com:5432/postgres";
  const VERIFY_FULL = `${URL}?sslmode=verify-full`;
  const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

  it("uses safe defaults and validated overrides from the environment", () => {
    expect(postgresConfig(readEnv({ DATABASE_URL: VERIFY_FULL }))).toEqual({ url: VERIFY_FULL, options: { max: 5, connectionTimeoutMillis: 10_000, queryTimeoutMillis: 30_000, sslCa: undefined } });
    const env = readEnv({ DATABASE_URL: URL, DATABASE_POOL_MAX: "2", DATABASE_CONNECT_TIMEOUT_MS: "5000", DATABASE_QUERY_TIMEOUT_MS: "60000", DATABASE_SSL_CA: CA });
    expect(postgresConfig(env).options).toEqual({ max: 2, connectionTimeoutMillis: 5000, queryTimeoutMillis: 60_000, sslCa: CA });
    for (const [key, value] of [["DATABASE_POOL_MAX", "0"], ["DATABASE_POOL_MAX", "x"], ["DATABASE_CONNECT_TIMEOUT_MS", "10"], ["DATABASE_QUERY_TIMEOUT_MS", "9999999"]]) {
      expect(() => readEnv({ [key]: value }), `${key}=${value}`).toThrow(new RegExp(key));
    }
  });

  it("rejects connection strings it cannot use, naming the variable but never the value", () => {
    const secret = "s3cret-pass";
    for (const bad of ["", "   ", `mysql://u:${secret}@h/db`, `postgresql:///db?password=${secret}`, `postgresql://u:${secret}@[bad/db`]) {
      let message = "";
      try {
        postgresConfig(readEnv({ DATABASE_URL: bad }));
      } catch (e) {
        message = (e as Error).message;
        expect(e, bad).toBeInstanceOf(DatabaseConfigurationError);
      }
      expect(message, bad).toMatch(/DATABASE_URL/);
      expect(message).not.toContain(secret);
    }
  });

  it("builds the pg pool settings: timeouts, pool size, application name, and SSL only when a CA is given", () => {
    expect(postgresPoolConfig(URL)).toEqual({ connectionString: URL, max: 5, connectionTimeoutMillis: 10_000, query_timeout: 30_000, idleTimeoutMillis: 30_000, application_name: "qa-pilot-ai" });
    expect(postgresPoolConfig(URL, { max: 1, connectionTimeoutMillis: 2000, queryTimeoutMillis: 120_000, sslCa: CA })).toMatchObject({ max: 1, connectionTimeoutMillis: 2000, query_timeout: 120_000, ssl: { ca: CA, rejectUnauthorized: true } });
  });

  it("passes the settings to the pool when the executor is selected", () => {
    const fake = fakePool();
    const createPool = vi.fn(() => fake.pool);
    selectSqlExecutor(readEnv({ DATABASE_PROVIDER: "supabase", DATABASE_URL: URL, DATABASE_POOL_MAX: "3", DATABASE_SSL_CA: CA }), vi.fn(), createPool);
    expect(createPool).toHaveBeenCalledWith(URL, { max: 3, connectionTimeoutMillis: 10_000, queryTimeoutMillis: 30_000, sslCa: CA });
  });
});

describe("PostgreSQL TLS", () => {
  const POOLER = "postgresql://postgres.ref:s3cret-pass@aws-0-region.pooler.supabase.com:5432/postgres";
  const CA = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----";
  const config = (vars: Record<string, string>) => postgresConfig(readEnv(vars));
  const failure = (vars: Record<string, string>) => {
    try {
      config(vars);
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseConfigurationError);
      return (e as Error).message;
    }
    throw new Error(`accepted: ${JSON.stringify(Object.keys(vars))}`);
  };

  it("verifies the server certificate against DATABASE_SSL_CA (Supabase session pooler), never disabling the check", () => {
    const { url, options } = config({ DATABASE_URL: POOLER, DATABASE_SSL_CA: CA });
    expect(url).toBe(POOLER);
    const pool = postgresPoolConfig(url, options);
    expect(pool.ssl).toEqual({ ca: CA, rejectUnauthorized: true });
    expect(pool.connectionString).toBe(POOLER); // no TLS parameters that pg would let override the CA check
  });

  it("accepts a CA stored on one line with literal \\n sequences", () => {
    expect(config({ DATABASE_URL: POOLER, DATABASE_SSL_CA: CA.replace(/\n/g, "\\n") }).options.sslCa).toBe(CA);
  });

  it("refuses a remote server without verified TLS instead of connecting unencrypted or unverified", () => {
    for (const query of ["", "?sslmode=disable", "?sslmode=prefer", "?sslmode=require", "?sslmode=verify-ca", "?sslmode=no-verify", "?ssl=true", "?sslmode=verify-full&uselibpqcompat=true"]) {
      const message = failure({ DATABASE_URL: `${POOLER}${query}` });
      expect(message, query).toMatch(/DATABASE_SSL_CA.*sslmode=verify-full/);
      expect(message).not.toContain("s3cret-pass");
    }
    expect(config({ DATABASE_URL: `${POOLER}?sslmode=verify-full` }).url).toContain("sslmode=verify-full"); // publicly trusted certificate
  });

  it("refuses TLS parameters in DATABASE_URL alongside DATABASE_SSL_CA, because pg would let them replace the CA check", () => {
    for (const query of ["?sslmode=verify-full", "?sslmode=no-verify", "?sslrootcert=/tmp/ca.pem", "?ssl=false", "?uselibpqcompat=true&sslmode=require"]) {
      const message = failure({ DATABASE_URL: `${POOLER}${query}`, DATABASE_SSL_CA: CA });
      expect(message, query).toMatch(/Remove .* from DATABASE_URL when DATABASE_SSL_CA is set/);
      expect(message).not.toContain("s3cret-pass");
    }
  });

  it("rejects an invalid CA without printing it", () => {
    for (const bad of ["not a certificate", "-----BEGIN CERTIFICATE-----", "MIIB-----END CERTIFICATE-----"]) {
      const message = failure({ DATABASE_URL: POOLER, DATABASE_SSL_CA: bad });
      expect(message, bad).toMatch(/DATABASE_SSL_CA must contain a PEM certificate/);
      expect(message).not.toContain("not a certificate");
    }
  });

  it("allows a PostgreSQL server on this machine without TLS (nothing leaves the host)", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) expect(config({ DATABASE_URL: `postgresql://u:p@${host}:5432/qa` }).options.sslCa).toBeUndefined();
  });
});

describe("PostgresExecutor: work that outlives its transaction (regression)", () => {
  it("never runs a late statement on a client that went back to the pool", async () => {
    const { pool, log, released } = fakePool();
    const sql = new PostgresExecutor(pool);
    let late!: Promise<unknown>;
    let lateInRollback!: Promise<unknown>;
    await sql.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (1)");
      late = new Promise((r) => setTimeout(r, 5)).then(() => sql.run("UPDATE t SET late = 1"));
    });
    await sql
      .transaction(async () => {
        lateInRollback = new Promise((r) => setTimeout(r, 5)).then(() => sql.run("UPDATE t SET late = 2"));
        throw new Error("rolled back");
      })
      .catch(() => undefined);
    await Promise.all([late, lateInRollback]);
    expect(released.map((r) => r.client)).toEqual(["client1", "client2"]);
    // Both late statements ran on the pool, as ordinary statements outside any transaction.
    expect(log.filter((l) => l.text.startsWith("UPDATE")).map((l) => l.on)).toEqual(["pool", "pool"]);
  });

  it("starts a new transaction (not a savepoint on a released client) when called after the outer one ended", async () => {
    const { pool, log } = fakePool();
    const sql = new PostgresExecutor(pool);
    let lateTx!: Promise<unknown>;
    await sql.transaction(async () => {
      lateTx = new Promise((r) => setTimeout(r, 5)).then(() => sql.transaction((tx) => tx.run("INSERT INTO t VALUES ('late')")));
    });
    await lateTx;
    expect(statements(log)).toEqual(["client1: BEGIN", "client1: COMMIT", "client2: BEGIN", "client2: INSERT INTO t VALUES ('late')", "client2: COMMIT"]);
  });
});
