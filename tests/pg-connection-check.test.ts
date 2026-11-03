import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_STATEMENTS, describeConnectionError, runReadOnlyCheck, sessionPoolerProblems, type CheckClient, type TlsInfo } from "@/lib/database/postgres/connection-check";
import { createPgPool } from "@/lib/database/sql/postgres-executor";
import { createPgTestDatabase } from "./support/postgres";

/**
 * The read-only Supabase connection check (scripts/pg-connection-check.ts). No hosted service is contacted: TLS is
 * exercised with the real pg client and the app's pool settings against a local fake PostgreSQL endpoint that uses
 * throwaway certificates generated here.
 */

const PASSWORD = "CANARY-pw-0042";
const POOLER = `postgresql://postgres.abcdefghijklmnop:${PASSWORD}@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`;
const VERIFIED: TlsInfo = { encrypted: true, authorized: true, protocol: "TLSv1.3", cipher: "TLS_AES_256_GCM_SHA384" };

describe("session pooler target", () => {
  it("accepts the Supabase session pooler string", () => {
    expect(sessionPoolerProblems(POOLER)).toEqual([]);
    expect(sessionPoolerProblems(POOLER.replace("aws-0-", "aws-1-"))).toEqual([]);
  });

  it("explains the direct connection, the transaction pooler and other mistakes without printing values", () => {
    const direct = sessionPoolerProblems(`postgresql://postgres:${PASSWORD}@db.abcdefghijklmnop.supabase.co:5432/postgres`);
    expect(direct.join(" ")).toMatch(/direct connection.*IPv6.*Session pooler/);
    expect(direct.join(" ")).toMatch(/postgres\.<project-ref>/);
    expect(sessionPoolerProblems(POOLER.replace(":5432/", ":6543/")).join(" ")).toMatch(/5432.*6543 is the transaction pooler/);
    expect(sessionPoolerProblems(POOLER.replace(`:${PASSWORD}@`, "@")).join(" ")).toMatch(/no password/);
    expect(sessionPoolerProblems("postgresql://u:p@example.com:5432/db").join(" ")).toMatch(/not a Supabase pooler host/);
    for (const m of [...direct, ...sessionPoolerProblems(POOLER.replace(":5432/", ":6543/"))]) expect(m).not.toMatch(/CANARY|abcdefghijklmnop/);
  });
});

describe("read-only check", () => {
  const fakeClient = (tlsInfo: TlsInfo | null, fail?: string) => {
    const sent: string[] = [];
    const client: CheckClient = {
      tls: () => tlsInfo,
      query: async (text) => {
        sent.push(text);
        if (text === fail) throw new Error("boom");
        if (text === CHECK_STATEMENTS.ping) return { rows: [{ ok: 1 }] };
        if (text === CHECK_STATEMENTS.server) return { rows: [{ server_version: "17.4", database: "postgres", read_only: "on" }] };
        if (text === CHECK_STATEMENTS.schema) return { rows: [{ public_tables: 0, migrations_table: false }] };
        return { rows: [] };
      },
    };
    return { client, sent };
  };

  it("sends only SELECTs inside a READ ONLY transaction and always rolls back", async () => {
    const { client, sent } = fakeClient(VERIFIED);
    expect(await runReadOnlyCheck(client)).toMatchObject({ ping: true, serverVersion: "17.4", database: "postgres", readOnly: true, publicTables: 0, migrationsTable: false });
    expect(sent).toEqual([CHECK_STATEMENTS.begin, CHECK_STATEMENTS.ping, CHECK_STATEMENTS.server, CHECK_STATEMENTS.schema, CHECK_STATEMENTS.rollback]);
    for (const s of sent.slice(1, -1)) expect(s).toMatch(/^SELECT /);
    expect(sent.join("\n")).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|COPY|SET\s+(?!TRANSACTION))\b/i);

    const failing = fakeClient(VERIFIED, CHECK_STATEMENTS.server);
    await expect(runReadOnlyCheck(failing.client)).rejects.toThrow("boom");
    expect(failing.sent.at(-1)).toBe(CHECK_STATEMENTS.rollback);
  });

  it("sends nothing unless the connection is encrypted and verified", async () => {
    for (const info of [null, { ...VERIFIED, encrypted: false }, { ...VERIFIED, authorized: false }]) {
      const { client, sent } = fakeClient(info);
      await expect(runReadOnlyCheck(client)).rejects.toThrow(/not encrypted|not verified/);
      expect(sent).toEqual([]);
    }
  });

  it("runs its statements on real PostgreSQL (PGlite) in a read-only transaction", async () => {
    const pg = await createPgTestDatabase();
    try {
      const client: CheckClient = { tls: () => VERIFIED, query: async (text) => ({ rows: (await pg.db.query(text)).rows as Record<string, unknown>[] }) };
      const report = await runReadOnlyCheck(client);
      expect(report).toMatchObject({ ping: true, database: "postgres", readOnly: true, migrationsTable: true });
      expect(report.publicTables).toBeGreaterThan(10);
      expect(report.serverVersion).toMatch(/^\d+/);
    } finally {
      await pg.close();
    }
  });
});

describe("failure messages", () => {
  const CA = "-----BEGIN CERTIFICATE-----\nCANARYCERT\n-----END CERTIFICATE-----";
  const secrets = [POOLER, PASSWORD, "aws-0-ap-northeast-1.pooler.supabase.com", CA];

  it("explains known causes and never prints the password, URL, host or certificate", () => {
    const cases: [unknown, RegExp][] = [
      [Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }), /TLS verification failed.*DATABASE_SSL_CA/],
      [Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: aws-0-ap-northeast-1.pooler.supabase.com"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), /does not match the host name/],
      [new Error("The server does not support SSL connections"), /does not offer TLS.*never downgraded/],
      [Object.assign(new Error("getaddrinfo ENOTFOUND aws-0-ap-northeast-1.pooler.supabase.com"), { code: "ENOTFOUND" }), /DNS lookup failed/],
      [Object.assign(new Error('password authentication failed for user "postgres.abcdefghijklmnop"'), { code: "28P01" }), /Authentication failed/],
      [Object.assign(new Error(`unexpected ${POOLER} ${PASSWORD} aws-0-ap-northeast-1.pooler.supabase.com ${CA}`), { code: "XX000" }), /XX000/],
    ];
    for (const [error, expected] of cases) {
      const text = describeConnectionError(error, secrets);
      expect(text).toMatch(expected);
      expect(text).not.toMatch(/CANARY|pooler\.supabase\.com|postgresql:\/\/|abcdefghijklmnop/);
    }
  });
});

const opensslAvailable = spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!opensslAvailable)("TLS verification with the real pg client (local fake server, throwaway certificates)", () => {
  let dir = "";
  const files: Record<string, string> = {};

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-pg-tls-"));
    const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    const ca = (name: string) => run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "2", "-subj", `/CN=${name}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
    const leaf = (name: string, host: string, signer: string) => {
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${host}`]);
      fs.writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=DNS:${host}\n`);
      run(["x509", "-req", "-in", `${name}.csr`, "-CA", `${signer}.pem`, "-CAkey", `${signer}.key`, "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`]);
    };
    ca("trusted-ca");
    ca("other-ca");
    leaf("good", "localhost", "trusted-ca");
    leaf("wrong-name", "db.other.example", "trusted-ca");
    leaf("wrong-ca", "localhost", "other-ca");
    for (const f of fs.readdirSync(dir)) files[f] = fs.readFileSync(path.join(dir, f), "utf8");
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A PostgreSQL-like endpoint: answers the SSLRequest, then completes a TLS handshake (or refuses TLS) and hangs up. */
  async function fakePostgres(cert: string | null) {
    const state = { handshakes: 0, open: 0 };
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      state.open++;
      socket.on("close", () => {
        state.open--;
        sockets.delete(socket);
      });
      socket.on("error", () => undefined);
      socket.once("data", (buf) => {
        if (buf.length < 8 || buf.readInt32BE(4) !== 80877103) return socket.destroy(); // not an SSLRequest
        if (!cert) return void socket.write("N");
        socket.write("S");
        const secure = new tls.TLSSocket(socket, { isServer: true, key: files[`${cert}.key`], cert: files[`${cert}.pem`] });
        secure.on("secure", () => {
          state.handshakes++;
          secure.destroy();
        });
        secure.on("error", () => socket.destroy());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as net.AddressInfo).port;
    return { port, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  /** Connects like the app (createPgPool with the CA), returns the error and closes the pool. */
  async function connect(port: number, ca: string) {
    const pool = createPgPool(`postgresql://postgres.ref:${PASSWORD}@localhost:${port}/postgres`, { max: 1, sslCa: files[`${ca}.pem`], connectionTimeoutMillis: 5_000 });
    let error: unknown = null;
    try {
      (await pool.connect()).release(true);
    } catch (e) {
      error = e;
    } finally {
      await pool.end();
    }
    return error as (Error & { code?: string }) | null;
  }

  it("completes the TLS handshake only with a certificate from DATABASE_SSL_CA for the right host", async () => {
    const server = await fakePostgres("good");
    try {
      const error = await connect(server.port, "trusted-ca");
      expect(server.state.handshakes).toBe(1); // verified handshake; the fake then hangs up
      expect(error?.code).toBeUndefined(); // not a TLS error: the server closed after TLS
    } finally {
      await server.close();
    }
  });

  it("refuses a server whose certificate is not signed by DATABASE_SSL_CA", async () => {
    const server = await fakePostgres("wrong-ca");
    try {
      const error = await connect(server.port, "trusted-ca");
      expect(error?.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/);
      expect(describeConnectionError(error, [PASSWORD])).toMatch(/TLS verification failed/);
      expect(server.state.handshakes).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("refuses a certificate issued for another host name (host name verification)", async () => {
    const server = await fakePostgres("wrong-name");
    try {
      const error = await connect(server.port, "trusted-ca");
      expect(error?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
      expect(describeConnectionError(error, [PASSWORD])).toMatch(/does not match the host name/);
    } finally {
      await server.close();
    }
  });

  it("refuses a server that does not offer TLS instead of continuing unencrypted", async () => {
    const server = await fakePostgres(null);
    try {
      const error = await connect(server.port, "trusted-ca");
      expect(error?.message).toMatch(/does not support SSL/);
      expect(describeConnectionError(error, [PASSWORD])).toMatch(/never downgraded/);
    } finally {
      await server.close();
    }
  });

  it("closes every connection afterwards", async () => {
    const server = await fakePostgres("wrong-ca");
    try {
      await connect(server.port, "trusted-ca");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.state.open).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("the script stops before connecting when the configuration is unsafe", () => {
  const script = (env: Record<string, string>) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DATABASE_") && !k.startsWith("SUPABASE_")));
    const r = spawnSync(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/pg-connection-check.ts"], { env: { ...clean, ...env } as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const CA = "-----BEGIN CERTIFICATE-----\nCANARYCERT\n-----END CERTIFICATE-----";

  it("refuses without a CA, with an invalid CA, with TLS overrides, or with the direct connection, printing no values", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ DATABASE_URL: POOLER }, /DATABASE_SSL_CA is not set/],
      [{ DATABASE_URL: POOLER, DATABASE_SSL_CA: "not a certificate CANARY" }, /DATABASE_SSL_CA must contain a PEM certificate/],
      [{ DATABASE_URL: `${POOLER}?sslmode=no-verify`, DATABASE_SSL_CA: CA }, /Remove sslmode from DATABASE_URL/],
      [{ DATABASE_URL: `postgresql://postgres:${PASSWORD}@db.abcdefghijklmnop.supabase.co:5432/postgres`, DATABASE_SSL_CA: CA }, /direct connection/],
    ];
    for (const [env, expected] of cases) {
      const r = script(env);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(expected);
      expect(r.out).not.toMatch(/CANARY|abcdefghijklmnop|pooler\.supabase\.com|postgresql:\/\//);
      expect(r.out).not.toMatch(/Connection closed/); // stopped before opening a pool
    }
  }, 120_000);
});
