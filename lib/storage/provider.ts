/**
 * Binary artifact storage (reference documents, screenshots, traces, generated reports).
 *
 * Keys are forward-slash, relative paths such as `projects/<id>/documents/<uuid>.pdf`.
 * Implementations must reject keys that escape their root.
 */
export interface StorageProvider {
  readonly kind: StorageProviderKind;
  put(key: string, data: Uint8Array, options?: { contentType?: string }): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  /** Deletes every object whose key starts with `prefix/`. Returns the number removed. */
  deletePrefix(prefix: string): Promise<number>;
}

export type StorageProviderKind = "local-filesystem" | "s3" | "supabase-storage" | "vercel-blob";

export interface StoredObject {
  key: string;
  sizeBytes: number;
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = "InvalidStorageKeyError";
  }
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validates a storage key: relative, forward slashes, safe characters, no `..` segments. */
export function assertValidStorageKey(key: string): void {
  if (!key || key.length > 512 || key.startsWith("/") || key.includes("\\")) {
    throw new InvalidStorageKeyError(key);
  }
  for (const segment of key.split("/")) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new InvalidStorageKeyError(key);
    }
  }
}
