import type { AppEnv } from "@/lib/config/env";
import type { SqliteDatabase } from "../local/sqlite-client";
import type { SqlExecutor } from "./executor";
import { createPostgresExecutor, type PgPoolLike } from "./postgres-executor";
import { SqliteExecutor } from "./sqlite-executor";

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

/**
 * Chooses the SqlExecutor from configuration. SQLite (`DATABASE_PROVIDER=local`, the default) unless PostgreSQL is
 * selected explicitly (`DATABASE_PROVIDER=supabase` with `DATABASE_URL`). A PostgreSQL selection never falls back to
 * SQLite: a missing or invalid `DATABASE_URL` is an error, and the SQLite file is not opened.
 *
 * Not used by the app yet: the database provider still requires SQLite (see lib/database/index.ts).
 */
export function selectSqlExecutor(
  env: Pick<AppEnv, "DATABASE_PROVIDER" | "DATABASE_URL">,
  openSqlite: () => SqliteDatabase,
  createPool?: (connectionString: string) => PgPoolLike,
): SqlExecutor {
  switch (env.DATABASE_PROVIDER) {
    case "local":
      return new SqliteExecutor(openSqlite());
    case "supabase": {
      const url = env.DATABASE_URL;
      // The value is never echoed: it contains the database password.
      if (!url) throw new DatabaseConfigurationError("DATABASE_PROVIDER=supabase requires DATABASE_URL (a PostgreSQL connection string).");
      if (!/^postgres(ql)?:\/\//.test(url)) throw new DatabaseConfigurationError("DATABASE_URL must be a postgres:// or postgresql:// connection string.");
      return createPostgresExecutor(url, createPool);
    }
  }
}
