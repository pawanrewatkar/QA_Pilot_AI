import { assertValidStorageKey, type StorageProvider, type StoredObject } from "./provider";

/**
 * The parts of a Supabase Storage bucket client (`supabase.storage.from(bucket)`) this provider uses. A structural
 * type, so tests can supply an in-memory fake.
 */
export interface StorageBucketApi {
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): Promise<{ data: unknown; error: unknown }>;
  download(path: string): Promise<{ data: Blob | null; error: unknown }>;
  exists(path: string): Promise<{ data: boolean; error: unknown }>;
  remove(paths: string[]): Promise<{ data: unknown[] | null; error: unknown }>;
  list(path: string, options: { limit: number; offset: number }): Promise<{ data: { name: string; id: string | null }[] | null; error: unknown }>;
}

/** A Storage operation failed. The message names the operation, key and status; never the project URL or key. */
export class StorageOperationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StorageOperationError";
  }
}

/** The object is larger than the configured limit; nothing was uploaded. */
export class StorageObjectTooLargeError extends Error {
  constructor(key: string, sizeBytes: number, maxBytes: number) {
    super(`Refused to store ${key}: ${sizeBytes} bytes exceeds the ${maxBytes}-byte limit (STORAGE_MAX_OBJECT_MB).`);
    this.name = "StorageObjectTooLargeError";
  }
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  eml: "message/rfc822",
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
};

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[key.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

interface ErrorInfo {
  status?: number;
  code?: string;
  message: string;
}

function info(error: unknown): ErrorInfo {
  const e = (error ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; originalError?: { status?: unknown } };
  const status = typeof e.status === "number" ? e.status : typeof e.originalError?.status === "number" ? e.originalError.status : undefined;
  const code = typeof e.statusCode === "string" ? e.statusCode : typeof e.code === "string" ? e.code : undefined;
  return { status, code, message: typeof e.message === "string" ? e.message : String(error) };
}

/** Supabase reports a missing object as 404, or as 400 with statusCode "404" / "not_found", depending on the version. */
function isNotFound(error: unknown): boolean {
  const { status, code, message } = info(error);
  return status === 404 || code === "404" || code === "not_found" || code === "NoSuchKey" || (status === 400 && /not.?found/i.test(message));
}

/** Network failures (no HTTP status), server errors and rate limiting are worth retrying; client errors are not. */
function isTransient(error: unknown): boolean {
  const { status } = info(error);
  return status === undefined || status >= 500 || status === 429;
}

export interface SupabaseStorageOptions {
  maxObjectBytes: number;
  /** Attempts per operation for transient failures (default 3). */
  attempts?: number;
  /** Base delay between retries, doubled each time (default 250 ms). */
  retryDelayMs?: number;
}

/**
 * StorageProvider on a private Supabase Storage bucket, used with a server-only secret key (which bypasses Storage
 * policies, so it must never reach a browser). Objects are never public: downloads go through the app's routes,
 * which check ownership first. Same behaviour as LocalStorageProvider: `put` replaces an existing object, `get` returns
 * null for a missing one, `delete` reports whether something was removed, `deletePrefix` removes everything under a
 * prefix and returns the count.
 */
export class SupabaseStorageProvider implements StorageProvider {
  readonly kind = "supabase-storage" as const;
  private readonly attempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly bucket: StorageBucketApi,
    private readonly options: SupabaseStorageOptions,
  ) {
    this.attempts = Math.max(1, options.attempts ?? 3);
    this.retryDelayMs = options.retryDelayMs ?? 250;
  }

  async put(key: string, data: Uint8Array, options: { contentType?: string } = {}): Promise<StoredObject> {
    assertValidStorageKey(key);
    if (data.byteLength > this.options.maxObjectBytes) throw new StorageObjectTooLargeError(key, data.byteLength, this.options.maxObjectBytes);
    await this.call("upload", key, () => this.bucket.upload(key, data, { contentType: options.contentType ?? contentTypeFor(key), upsert: true }));
    return { key, sizeBytes: data.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertValidStorageKey(key);
    const blob = await this.call("download", key, () => this.bucket.download(key), { missing: null });
    return blob ? new Uint8Array(await (blob as Blob).arrayBuffer()) : null;
  }

  async exists(key: string): Promise<boolean> {
    assertValidStorageKey(key);
    // A HEAD request has no error body, so a missing object is a bare 400 or 404 (as the client itself treats it).
    return (await this.call("exists", key, () => this.bucket.exists(key), { missing: false, statuses: [400, 404] })) === true;
  }

  async delete(key: string): Promise<boolean> {
    assertValidStorageKey(key);
    const removed = await this.call("remove", key, () => this.bucket.remove([key]));
    return Array.isArray(removed) && removed.length > 0;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const root = prefix.replace(/\/+$/, "");
    assertValidStorageKey(root);
    const keys = await this.listAll(root);
    let removed = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const data = await this.call("remove", `${root}/`, () => this.bucket.remove(batch));
      removed += Array.isArray(data) ? data.length : 0;
    }
    return removed;
  }

  /** Every object key under `folder` (recursively). Entries without an id are folders. */
  private async listAll(folder: string): Promise<string[]> {
    const keys: string[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const page = ((await this.call("list", `${folder}/`, () => this.bucket.list(folder, { limit: pageSize, offset }), { missing: [] })) ?? []) as {
        name: string;
        id: string | null;
      }[];
      for (const entry of page) {
        const key = `${folder}/${entry.name}`;
        if (entry.id === null) keys.push(...(await this.listAll(key)));
        else keys.push(key);
      }
      if (page.length < pageSize) return keys;
    }
  }

  /** Runs one Storage call: retries transient failures, maps "not found", and throws a sanitized error otherwise. */
  private async call<T>(operation: string, key: string, fn: () => Promise<{ data: T; error: unknown }>, notFound?: { missing: T; statuses?: number[] }): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      let result: { data: T; error: unknown };
      try {
        result = await fn();
      } catch (error) {
        result = { data: null as T, error };
      }
      if (!result.error) return result.data;
      if (notFound && (isNotFound(result.error) || notFound.statuses?.includes(info(result.error).status ?? -1))) return notFound.missing;
      lastError = result.error;
      if (!isTransient(result.error) || attempt === this.attempts) break;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** (attempt - 1)));
    }
    const { status, code } = info(lastError);
    throw new StorageOperationError(`Storage ${operation} failed for ${key}${status ? ` (HTTP ${status}${code && code !== String(status) ? `, ${code}` : ""})` : " (network error)"}`, status);
  }
}
