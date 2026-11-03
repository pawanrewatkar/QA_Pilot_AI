import { resolveFromRoot, type AppEnv } from "@/lib/config/env";
import { LocalDatabaseProvider } from "./local/local-database-provider";
import type { DatabaseProvider } from "./provider";
import type { SqlExecutor } from "./sql/executor";
import { createSupabaseDatabaseProvider } from "./supabase/supabase-database-provider";

export type OpenedDatabase = DatabaseProvider & { readonly sql: SqlExecutor };

/**
 * Opens the configured database for the web app and the worker alike: SQLite by default
 * (`DATABASE_PROVIDER=local`, migrated on open), or PostgreSQL when selected explicitly (`DATABASE_PROVIDER=supabase`,
 * migrated separately with scripts/pg-migrate.ts). A PostgreSQL selection never falls back to SQLite.
 */
export function openDatabaseProvider(env: AppEnv): OpenedDatabase {
  switch (env.DATABASE_PROVIDER) {
    case "supabase":
      return createSupabaseDatabaseProvider(env);
    case "local":
      return LocalDatabaseProvider.open(resolveFromRoot(env.DATABASE_PATH));
  }
}
