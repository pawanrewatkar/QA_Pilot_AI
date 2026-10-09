import fs from "node:fs/promises";
import path from "node:path";
import { fetchUrl } from "@/lib/net/http";
import type { SourceKind } from "./types";
import { validateWorkbookFile } from "./workbook";

/** A workbook obtained from one of the supported sources, validated but not yet parsed. */
export interface WorkbookFile {
  kind: SourceKind;
  /** Display name (sanitized; secrets removed from links). */
  sourceName: string;
  fileName: string;
  bytes: Uint8Array;
}

/** User-facing error: the message is safe to show as is. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/**
 * Where test-case workbooks come from. Implementations return validated bytes; parsing is shared.
 * A future authenticated Google Drive provider (OAuth) implements the same interface.
 */
export interface ExternalTestCaseSourceProvider<Input> {
  readonly kind: SourceKind;
  load(input: Input): Promise<WorkbookFile>;
}

function validated(kind: SourceKind, sourceName: string, fileName: string, bytes: Uint8Array, maxBytes: number): WorkbookFile {
  const check = validateWorkbookFile(fileName, bytes, maxBytes);
  if (!check.ok) throw new SourceError(check.error);
  return { kind, sourceName, fileName: check.fileName, bytes };
}

/** A workbook uploaded through the browser. */
export class UploadSourceProvider implements ExternalTestCaseSourceProvider<{ fileName: string; bytes: Uint8Array }> {
  readonly kind = "UPLOAD" as const;
  constructor(private readonly maxBytes: number) {}
  async load(input: { fileName: string; bytes: Uint8Array }) {
    return validated(this.kind, input.fileName, input.fileName, input.bytes, this.maxBytes);
  }
}

/**
 * A workbook on the machine running QA Pilot AI. Only files inside the configured folder
 * (EXTERNAL_TEST_CASES_DIR) can be read, so a path can never reach other files on the server.
 */
export class LocalPathSourceProvider implements ExternalTestCaseSourceProvider<string> {
  readonly kind = "LOCAL_PATH" as const;
  private readonly root: string;
  constructor(rootDir: string, private readonly maxBytes: number) {
    this.root = path.resolve(rootDir);
  }

  get folder() {
    return this.root;
  }

  async load(input: string) {
    const raw = input.trim();
    if (!raw) throw new SourceError("Enter the path of an Excel file.");
    const full = path.resolve(this.root, raw);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new SourceError(`For safety, local files must be inside the test-case folder (${this.root}). Copy the workbook there or upload it instead.`);
    }
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      throw new SourceError(`No file was found at "${path.relative(this.root, full)}" in the test-case folder.`);
    }
    if (!stat.isFile()) throw new SourceError("The path does not point to a file.");
    if (stat.size > this.maxBytes) throw new SourceError(`The workbook is too large. Maximum size is ${Math.round(this.maxBytes / 1024 / 1024)} MB.`);
    const bytes = new Uint8Array(await fs.readFile(full));
    return validated(this.kind, path.relative(this.root, full), path.basename(full), bytes, this.maxBytes);
  }
}

export const DRIVE_UNAVAILABLE = "Unable to access the Google Drive file. Please verify that the file is accessible or upload the Excel file directly.";

const GOOGLE_HOSTS = /^(docs\.google\.com|drive\.google\.com|drive\.usercontent\.google\.com|[a-z0-9-]+\.googleusercontent\.com)$/;

/** Extracts the file id and the export URL from a Google Drive / Google Sheets share link. */
export function parseDriveLink(link: string): { id: string; downloadUrl: string; isSpreadsheet: boolean } | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/^(docs|drive)\.google\.com$/.test(url.hostname)) return null;
  const sheet = /\/spreadsheets\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
  if (sheet) return { id: sheet[1], isSpreadsheet: true, downloadUrl: `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=xlsx` };
  const file = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1] ?? url.searchParams.get("id");
  if (file && /^[A-Za-z0-9_-]{10,}$/.test(file)) return { id: file, isSpreadsheet: false, downloadUrl: `https://drive.google.com/uc?export=download&id=${file}` };
  return null;
}

/**
 * A workbook shared by link ("anyone with the link can view"). No Google API or OAuth is used: the
 * public export/download URL is fetched, redirects may only stay on Google hosts, and the response
 * must be an Excel workbook. Anything else (login page, permission page, virus-scan page) is reported
 * with DRIVE_UNAVAILABLE.
 */
export class GoogleDriveLinkSourceProvider implements ExternalTestCaseSourceProvider<string> {
  readonly kind = "GOOGLE_DRIVE" as const;
  constructor(
    private readonly maxBytes: number,
    private readonly fetcher: typeof fetchUrl = fetchUrl,
  ) {}

  async load(link: string) {
    const parsed = parseDriveLink(link);
    if (!parsed) throw new SourceError("Enter a Google Drive or Google Sheets share link (https://drive.google.com/… or https://docs.google.com/spreadsheets/…).");
    const res = await this.fetcher(parsed.downloadUrl, {
      readBody: "bytes",
      maxBodyBytes: this.maxBytes + 1,
      timeoutMs: 30_000,
      allowRedirect: (_from, to) => {
        try {
          const u = new URL(to);
          return u.protocol === "https:" && GOOGLE_HOSTS.test(u.hostname);
        } catch {
          return false;
        }
      },
    });
    if (!res.ok || !res.bytes) throw new SourceError(DRIVE_UNAVAILABLE);
    if (res.truncated) throw new SourceError(`The workbook is too large. Maximum size is ${Math.round(this.maxBytes / 1024 / 1024)} MB.`);
    const sourceName = `Google Drive file ${parsed.id.slice(0, 6)}…`;
    try {
      return validated(this.kind, sourceName, `${parsed.isSpreadsheet ? "google-sheet" : "drive-file"}-${parsed.id.slice(0, 12)}.xlsx`, res.bytes, this.maxBytes);
    } catch {
      // Google answered with something other than a workbook (sign-in, permission or warning page).
      throw new SourceError(DRIVE_UNAVAILABLE);
    }
  }
}

/**
 * Placeholder for private Drive files: would use OAuth and the Drive API. Not available in this
 * version; shared links are handled by GoogleDriveLinkSourceProvider.
 */
export class GoogleDriveTestCaseProvider implements ExternalTestCaseSourceProvider<{ fileId: string; accessToken: string }> {
  readonly kind = "GOOGLE_DRIVE" as const;
  async load(): Promise<WorkbookFile> {
    throw new SourceError("Private Google Drive access (OAuth) is not available yet. Share the file with “Anyone with the link” or upload it directly.");
  }
}
