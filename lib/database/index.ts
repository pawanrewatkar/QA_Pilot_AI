import "server-only";
import { readEnv, resolveFromRoot } from "@/lib/config/env";
import { LocalDatabaseProvider } from "./local/local-database-provider";
import type { DatabaseProvider } from "./provider";
import { createSupabaseDatabaseProvider } from "./supabase/supabase-database-provider";

export type { DatabaseProvider } from "./provider";

// Cached on globalThis so dev-mode hot reloads reuse one SQLite connection.
const globalCache = globalThis as unknown as { __qaPilotDb?: DatabaseProvider };

export function createDatabaseProvider(): DatabaseProvider {
  const env = readEnv();
  switch (env.DATABASE_PROVIDER) {
    case "supabase":
      return createSupabaseDatabaseProvider();
    case "local":
      return LocalDatabaseProvider.open(resolveFromRoot(env.DATABASE_PATH));
  }
}

/** Returns the process-wide database provider, opening and migrating it on first use. */
export function getDatabase(): DatabaseProvider {
  globalCache.__qaPilotDb ??= createDatabaseProvider();
  return globalCache.__qaPilotDb;
}
