import "server-only";
import { assertDeployable } from "@/lib/config/deployment";
import { readEnv } from "@/lib/config/env";
import type { StorageProvider } from "./provider";
import { createStorageProvider } from "./select";

export type { StorageProvider } from "./provider";

const globalCache = globalThis as unknown as { __qaPilotStorage?: StorageProvider };

/** The process-wide StorageProvider (local files by default; see lib/storage/select.ts). */
export function getStorage(): StorageProvider {
  if (!globalCache.__qaPilotStorage) {
    const env = readEnv();
    assertDeployable(env);
    globalCache.__qaPilotStorage = createStorageProvider({ ...env, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL });
  }
  return globalCache.__qaPilotStorage;
}
