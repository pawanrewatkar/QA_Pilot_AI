import "server-only";
import { assertDeployable } from "@/lib/config/deployment";
import { readEnv } from "@/lib/config/env";
import { openDatabaseProvider } from "./open";
import type { DatabaseProvider } from "./provider";

export type { DatabaseProvider } from "./provider";

// Cached on globalThis so dev-mode hot reloads reuse one connection (SQLite file or PostgreSQL pool).
const globalCache = globalThis as unknown as { __qaPilotDb?: DatabaseProvider };

export function createDatabaseProvider(): DatabaseProvider {
  const env = readEnv();
  assertDeployable(env);
  return openDatabaseProvider(env);
}

/** Returns the process-wide database provider, opening (and, for SQLite, migrating) it on first use. */
export function getDatabase(): DatabaseProvider {
  globalCache.__qaPilotDb ??= createDatabaseProvider();
  return globalCache.__qaPilotDb;
}
