/**
 * Read-only check of the hosted PostgreSQL connection through the Supabase session pooler, with verified TLS.
 *
 *   npx tsx --env-file=.env.supabase.local scripts/pg-connection-check.ts
 *
 * Needs DATABASE_URL (session pooler string, no sslmode) and DATABASE_SSL_CA (Supabase's CA certificate). Runs only
 * SELECT statements inside a READ ONLY transaction that is rolled back; creates, changes and migrates nothing. Never
 * prints the password, the connection string, the host name or the certificate. Exit code 0 only when every check passes.
 */
import { TLSSocket } from "node:tls";
import type { PoolClient } from "pg";
import { readEnv } from "@/lib/config/env";
import { describeConnectionError, runReadOnlyCheck, sessionPoolerProblems, type CheckClient } from "@/lib/database/postgres/connection-check";
import { createPgPool } from "@/lib/database/sql/postgres-executor";
import { postgresConfig } from "@/lib/database/sql/select-executor";

// tsx runs these scripts as CommonJS (no top-level await), so the work happens in main().
async function main(): Promise<void> {
  function fail(message: string): never {
    console.error(`FAILED: ${message}`);
    process.exit(1);
  }

  const env = readEnv();
  if (!env.DATABASE_SSL_CA?.trim()) fail("DATABASE_SSL_CA is not set. Download Supabase's CA certificate (Dashboard → Database settings → SSL Configuration) and set it.");
  let config: ReturnType<typeof postgresConfig>;
  try {
    config = postgresConfig(env); // same validation as the app: verified TLS required, no TLS overrides in DATABASE_URL
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const problems = sessionPoolerProblems(config.url);
  if (problems.length) fail(problems.join(" "));

  const url = new URL(config.url);
  const secrets = [config.url, decodeURIComponent(url.password), url.password, url.hostname, env.DATABASE_SSL_CA ?? "", config.options.sslCa ?? ""];
  console.log("Target: Supabase session pooler (port 5432). TLS: required, verified against DATABASE_SSL_CA, host name checked.");

  const pool = createPgPool(config.url, { ...config.options, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const connected = client;
    const checkClient: CheckClient = {
      query: async (text) => ({ rows: (await connected.query(text)).rows as Record<string, unknown>[] }),
      tls: () => {
        // pg keeps the socket on its (undocumented but long-standing) `connection.stream`.
        const stream = (connected as unknown as { connection?: { stream?: unknown } }).connection?.stream;
        if (!(stream instanceof TLSSocket)) return { encrypted: false, authorized: false, protocol: null, cipher: null };
        return { encrypted: stream.encrypted, authorized: stream.authorized, protocol: stream.getProtocol(), cipher: stream.getCipher()?.name ?? null };
      },
    };
    const report = await runReadOnlyCheck(checkClient);
    console.log(`TLS: verified (${report.tls.protocol}, ${report.tls.cipher}); certificate chain and host name accepted.`);
    console.log(`SELECT 1: ${report.ping ? "ok" : "unexpected result"}`);
    console.log(`Server: PostgreSQL ${report.serverVersion}, database "${report.database}", transaction read-only: ${report.readOnly ? "yes" : "NO"}`);
    console.log(`Schema: ${report.publicTables} table(s) in public; qa_pilot_migrations ${report.migrationsTable ? "present" : "absent (schema not applied yet)"}`);
    if (!report.ping || !report.readOnly) process.exitCode = 1;
    else console.log("PASSED: read-only transaction rolled back; nothing was changed.");
  } catch (error) {
    console.error(`FAILED: ${describeConnectionError(error, secrets)}`);
    process.exitCode = 1;
  } finally {
    client?.release(true); // discard the session instead of returning it to the pool
    await pool.end();
    console.log("Connection closed.");
  }
}

main().catch((error: unknown) => {
  // Unexpected failure outside the checks: scrub everything that could identify or unlock the database.
  const env = process.env;
  console.error(`FAILED: ${describeConnectionError(error, [env.DATABASE_URL ?? "", env.DATABASE_SSL_CA ?? "", env.SUPABASE_SECRET_KEY ?? ""])}`);
  process.exit(1);
});
