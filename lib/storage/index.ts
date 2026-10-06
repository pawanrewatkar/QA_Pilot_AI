import "server-only";
import { readEnv, resolveFromRoot } from "@/lib/config/env";
import { LocalStorageProvider } from "./local-storage-provider";
import type { StorageProvider } from "./provider";

export type { StorageProvider } from "./provider";

const globalCache = globalThis as unknown as { __qaPilotStorage?: StorageProvider };

export function getStorage(): StorageProvider {
  if (!globalCache.__qaPilotStorage) {
    const env = readEnv();
    globalCache.__qaPilotStorage = new LocalStorageProvider(resolveFromRoot(env.STORAGE_PATH));
  }
  return globalCache.__qaPilotStorage;
}
