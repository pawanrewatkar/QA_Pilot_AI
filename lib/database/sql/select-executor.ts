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

/**
 * Validates the PostgreSQL settings and returns the connection string and pool options. Errors name the variable but
 * never echo its value (DATABASE_URL contains the database password).
 */
export function postgresConfig(env: PostgresEnv): { url: string; options: PostgresPoolOptions } {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new DatabaseConfigurationError("DATABASE_PROVIDER=supabase requires DATABASE_URL (a PostgreSQL connection string).");
  if (!/^postgres(ql)?:\/\//.test(url)) throw new DatabaseConfigurationError("DATABASE_URL must be a postgres:// or postgresql:// connection string.");
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // fall through to the error below
  }
  if (!host) throw new DatabaseConfigurationError("DATABASE_URL could not be parsed. Percent-encode special characters in the user name and password.");
  const ca = env.DATABASE_SSL_CA?.trim();
  if (ca && !ca.includes("-----BEGIN CERTIFICATE-----")) throw new DatabaseConfigurationError("DATABASE_SSL_CA must contain a PEM certificate (-----BEGIN CERTIFICATE-----).");
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
