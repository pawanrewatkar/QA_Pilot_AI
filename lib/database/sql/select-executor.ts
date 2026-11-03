import type { AppEnv } from "@/lib/config/env";
import type { SqliteDatabase } from "../local/sqlite-client";
import type { SqlExecutor } from "./executor";
import { createPostgresExecutor, type PgPoolLike, type PostgresPoolOptions } from "./postgres-executor";
import { SqliteExecutor } from "./sqlite-executor";

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export type PostgresEnv = Pick<AppEnv, "DATABASE_URL" | "DATABASE_POOL_MAX" | "DATABASE_CONNECT_TIMEOUT_MS" | "DATABASE_QUERY_TIMEOUT_MS" | "DATABASE_SSL_CA">;

/** Connection-string parameters that configure TLS. In `pg` they override the pool's own `ssl` option. */
const URL_TLS_PARAMS = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat", "sslnegotiation"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A remote PostgreSQL server is only reached over TLS with a verified certificate; nothing downgrades silently.
 * - With DATABASE_SSL_CA (recommended for Supabase, whose certificates chain to Supabase's own root CA): the pool verifies
 *   the server against that CA (`rejectUnauthorized: true`, host name checked). TLS parameters in DATABASE_URL are refused,
 *   because `pg` would let them replace this check.
 * - Without it: DATABASE_URL must say `sslmode=verify-full` (verified against the system's trusted CAs). Other modes are
 *   refused: `disable`/`no-verify` do not verify, and `prefer`/`require`/`verify-ca` are deprecated aliases that become
 *   non-verifying in libpq-compatibility mode.
 * Only a server on this machine (loopback) may be used without TLS. Errors name settings, never values.
 */
function checkTls(url: URL, hasCa: boolean): void {
  const present = URL_TLS_PARAMS.filter((p) => url.searchParams.has(p));
  if (hasCa) {
    if (present.length) throw new DatabaseConfigurationError(`Remove ${present.join(", ")} from DATABASE_URL when DATABASE_SSL_CA is set: connection-string TLS settings would replace the certificate check.`);
    return;
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) return;
  if (url.searchParams.get("sslmode") !== "verify-full" || url.searchParams.has("uselibpqcompat")) {
    throw new DatabaseConfigurationError("DATABASE_URL points to a remote server without verified TLS. Set DATABASE_SSL_CA (for Supabase: its CA certificate), or add sslmode=verify-full for a server with a publicly trusted certificate.");
  }
}

/**
 * Validates the PostgreSQL settings and returns the connection string and pool options. Errors name the variable but
 * never echo its value (DATABASE_URL contains the database password).
 */
export function postgresConfig(env: PostgresEnv): { url: string; options: PostgresPoolOptions } {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new DatabaseConfigurationError("DATABASE_PROVIDER=supabase requires DATABASE_URL (a PostgreSQL connection string).");
  if (!/^postgres(ql)?:\/\//.test(url)) throw new DatabaseConfigurationError("DATABASE_URL must be a postgres:// or postgresql:// connection string.");
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // fall through to the error below
  }
  if (!parsed?.hostname) throw new DatabaseConfigurationError("DATABASE_URL could not be parsed. Percent-encode special characters in the user name and password.");
  // A PEM stored on one line (e.g. in a hosting dashboard) may carry literal "\n" sequences.
  const ca = env.DATABASE_SSL_CA?.trim().replace(/\\n/g, "\n");
  if (ca && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) throw new DatabaseConfigurationError("DATABASE_SSL_CA must contain a PEM certificate (-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----).");
  checkTls(parsed, !!ca);
  return {
    url,
    options: { max: env.DATABASE_POOL_MAX, connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_MS, queryTimeoutMillis: env.DATABASE_QUERY_TIMEOUT_MS, sslCa: ca || undefined },
  };
}

/**
 * Chooses the SqlExecutor from configuration. SQLite (`DATABASE_PROVIDER=local`, the default) unless PostgreSQL is
 * selected explicitly (`DATABASE_PROVIDER=supabase` with `DATABASE_URL`). A PostgreSQL selection never falls back to
 * SQLite: invalid settings are an error, and the SQLite file is not opened.
 *
 * Not used by the app yet: the database provider still requires SQLite (see lib/database/index.ts).
 */
export function selectSqlExecutor(
  env: Pick<AppEnv, "DATABASE_PROVIDER"> & PostgresEnv,
  openSqlite: () => SqliteDatabase,
  createPool?: (connectionString: string, options: PostgresPoolOptions) => PgPoolLike,
): SqlExecutor {
  switch (env.DATABASE_PROVIDER) {
    case "local":
      return new SqliteExecutor(openSqlite());
    case "supabase": {
      const { url, options } = postgresConfig(env);
      return createPostgresExecutor(url, createPool, options);
    }
  }
}
