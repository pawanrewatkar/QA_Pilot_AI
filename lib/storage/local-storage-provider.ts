import fs from "node:fs/promises";
import path from "node:path";
import { assertValidStorageKey, InvalidStorageKeyError, type StorageProvider, type StoredObject } from "./provider";

/** Stores artifacts on the local filesystem under a single root directory. */
export class LocalStorageProvider implements StorageProvider {
  readonly kind = "local-filesystem" as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    assertValidStorageKey(key);
    const full = path.resolve(this.root, ...key.split("/"));
    // Defence in depth on top of key validation.
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new InvalidStorageKeyError(key);
    }
    return full;
  }

  async put(key: string, data: Uint8Array): Promise<StoredObject> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Write to a temp file then rename, so readers never see a partial file.
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, full);
    return { key, sizeBytes: data.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.resolve(key)));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await fs.stat(this.resolve(key))).isFile();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await fs.unlink(this.resolve(key));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const dir = this.resolve(prefix.replace(/\/+$/, ""));
    let count = 0;
    try {
      const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
      count = entries.filter((e) => e.isFile()).length;
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return count;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
