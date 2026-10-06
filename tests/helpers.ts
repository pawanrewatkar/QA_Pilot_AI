import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabaseProvider } from "@/lib/database/local/local-database-provider";
import { IN_MEMORY } from "@/lib/database/local/sqlite-client";
import type { ProjectInput } from "@/types";

export function createTestDb(): LocalDatabaseProvider {
  return LocalDatabaseProvider.open(IN_MEMORY);
}

export function makeTempDir(prefix = "qa-pilot-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function projectInput(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return {
    name: "Example Site",
    websiteUrl: "https://example.com/",
    description: null,
    figmaUrl: null,
    testEmail: null,
    ...overrides,
  };
}

export const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
