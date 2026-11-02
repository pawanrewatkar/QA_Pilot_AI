import { createClient } from "@supabase/supabase-js";
import { resolveFromRoot, type AppEnv } from "@/lib/config/env";
import { LocalStorageProvider } from "./local-storage-provider";
import type { StorageProvider } from "./provider";
import { SupabaseStorageProvider, type StorageBucketApi } from "./supabase-storage-provider";

export class StorageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

export type StorageEnv = Pick<
  AppEnv,
  "STORAGE_PROVIDER" | "STORAGE_PATH" | "STORAGE_BUCKET" | "STORAGE_MAX_OBJECT_MB" | "SUPABASE_URL" | "SUPABASE_SECRET_KEY" | "SUPABASE_SERVICE_ROLE_KEY"
> & { NEXT_PUBLIC_SUPABASE_URL?: string };

/** The role claim of a legacy JWT key (`anon`, `service_role`), or null when the key is not a JWT. */
function jwtRole(key: string): string | null {
  const part = key.split(".")[1];
  if (key.split(".").length !== 3 || !part) return null;
  try {
    return (JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

/**
 * Validates the Supabase Storage settings. Errors name the variable, never its value. The key must be a secret key
 * (sb_secret_… or the legacy service_role JWT): a publishable or anon key could not write to a private bucket and
 * must never be relied on server-side.
 */
export function supabaseStorageConfig(env: StorageEnv): { url: string; key: string; bucket: string; maxObjectBytes: number } {
  const url = (env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) throw new StorageConfigurationError("STORAGE_PROVIDER=supabase requires SUPABASE_URL (the Supabase project URL).");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StorageConfigurationError("SUPABASE_URL is not a valid URL.");
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) throw new StorageConfigurationError("SUPABASE_URL must use https.");
  const key = (env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!key) throw new StorageConfigurationError("STORAGE_PROVIDER=supabase requires SUPABASE_SECRET_KEY (a server-only secret key).");
  if (key.startsWith("sb_publishable_") || jwtRole(key) === "anon") {
    throw new StorageConfigurationError("SUPABASE_SECRET_KEY must be a secret (or legacy service_role) key, not the publishable/anon key.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(env.STORAGE_BUCKET)) throw new StorageConfigurationError("STORAGE_BUCKET is not a valid bucket name.");
  return { url, key, bucket: env.STORAGE_BUCKET, maxObjectBytes: Math.floor(env.STORAGE_MAX_OBJECT_MB * 1024 * 1024) };
}

/** A server-side Storage bucket client. The key never leaves this process. */
export function createSupabaseBucket(url: string, key: string, bucket: string): StorageBucketApi {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return client.storage.from(bucket) as unknown as StorageBucketApi;
}

/**
 * The configured StorageProvider: local files by default (`STORAGE_PROVIDER=local`), or the private Supabase bucket
 * when selected explicitly. A Supabase selection never falls back to local files: invalid settings are an error.
 */
export function createStorageProvider(env: StorageEnv, bucketFactory: typeof createSupabaseBucket = createSupabaseBucket): StorageProvider {
  switch (env.STORAGE_PROVIDER) {
    case "local":
      return new LocalStorageProvider(resolveFromRoot(env.STORAGE_PATH));
    case "supabase": {
      const config = supabaseStorageConfig(env);
      return new SupabaseStorageProvider(bucketFactory(config.url, config.key, config.bucket), { maxObjectBytes: config.maxObjectBytes });
    }
  }
}
