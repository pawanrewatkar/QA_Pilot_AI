import { randomUUID } from "node:crypto";
import { ALL_VIEWPORTS } from "@/lib/constants/testing";
import { normalizeCrawlUrl } from "@/lib/crawler/normalize";
import type { DatabaseProvider } from "@/lib/database/provider";
import { detectMapping, validateMapping, type MappingValidation } from "@/lib/external-tests/mapping";
import { planResultColumns } from "@/lib/external-tests/result-columns";
import { GoogleDriveLinkSourceProvider, LocalPathSourceProvider, SourceError, UploadSourceProvider, type WorkbookFile } from "@/lib/external-tests/sources";
import { CASE_FIELDS, type ColumnMapping, type OutputMode, type SheetColumn, type SourceKind } from "@/lib/external-tests/types";
import { loadWorkbook, readSheet, toCases, WorkbookError, worksheetNames } from "@/lib/external-tests/workbook";
import { fetchUrl } from "@/lib/net/http";
import type { StorageProvider } from "@/lib/storage/provider";
import { isSameSite, normalizeWebsiteUrl } from "@/lib/validation/url";
import { BROWSERS, type BrowserName } from "@/types";
import { createProject } from "./projects";

/**
 * External Test Case Testing use-cases. The workflow is: inspect a source (the workbook is kept as a
 * draft), inspect a worksheet (mapping and preview), then start the execution.
 */
export interface ExternalTestDeps {
  db: DatabaseProvider;
  storage: StorageProvider;
  maxUploadBytes: number;
  /** Folder for local-path sources (EXTERNAL_TEST_CASES_DIR). */
  localDir: string;
  /** Overridable for tests. */
  fetcher?: typeof fetchUrl;
}

export type SourceInput = { kind: "UPLOAD"; fileName: string; bytes: Uint8Array } | { kind: "LOCAL_PATH"; path: string } | { kind: "GOOGLE_DRIVE"; link: string };

export interface SheetInspection {
  name: string;
  headerRow: number;
  columns: SheetColumn[];
  mapping: ColumnMapping;
  validation: MappingValidation;
  preview: { rowNumber: number; cells: Record<number, string> }[];
  totalRows: number;
  truncatedRows: number;
  /** Where results would go with "Existing Sheet" (e.g. "Actual Result 2 / Status 2 / Date 2"). */
  existingSheetTarget: string;
}

export interface DraftInspection {
  draftId: string;
  fileName: string;
  sourceKind: SourceKind;
  sourceName: string;
  sheets: string[];
  sheet: SheetInspection;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const draftKey = (id: string) => `external-drafts/${id}/source.xlsx`;
const PREVIEW_ROWS = 8;

const fail = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof SourceError || error instanceof WorkbookError ? error.message : `The workbook could not be processed: ${error instanceof Error ? error.message : String(error)}`,
});

async function loadSource(deps: ExternalTestDeps, input: SourceInput): Promise<WorkbookFile> {
  switch (input.kind) {
    case "UPLOAD":
      return new UploadSourceProvider(deps.maxUploadBytes).load({ fileName: input.fileName, bytes: input.bytes });
    case "LOCAL_PATH":
      return new LocalPathSourceProvider(deps.localDir, deps.maxUploadBytes).load(input.path);
    case "GOOGLE_DRIVE":
      return new GoogleDriveLinkSourceProvider(deps.maxUploadBytes, deps.fetcher).load(input.link);
  }
}

function inspectSheet(wb: Awaited<ReturnType<typeof loadWorkbook>>, sheetName: string, mapping?: ColumnMapping): SheetInspection {
  const sheet = readSheet(wb, sheetName);
  const ws = wb.getWorksheet(sheetName)!;
  const map = mapping ?? detectMapping(sheet.columns);
  const hasData = (col: number) => sheet.rows.some((r) => !!r.cells[col]);
  const target = planResultColumns(sheet.columns, hasData, ws.columnCount, new Set(Object.values(map).filter((v): v is number => typeof v === "number")));
  return {
    name: sheet.name,
    headerRow: sheet.headerRow,
    columns: sheet.columns,
    mapping: map,
    validation: validateMapping(map, sheet.columns),
    preview: sheet.rows.slice(0, PREVIEW_ROWS),
    totalRows: sheet.rows.length,
    truncatedRows: sheet.truncatedRows,
    existingSheetTarget: `${target.actual.header} / ${target.status.header} / ${target.date.header}${target.set > 1 ? ` (earlier results in “${target.set === 2 ? "Actual Result" : `Actual Result ${target.set - 1}`}” are kept)` : ""}`,
  };
}

/** Loads a workbook from the chosen source, keeps it as a draft and describes its first usable sheet. */
export async function inspectSource(deps: ExternalTestDeps, input: SourceInput): Promise<Result<DraftInspection>> {
  try {
    const file = await loadSource(deps, input);
    const wb = await loadWorkbook(file.bytes);
    const sheets = worksheetNames(wb);
    let first: SheetInspection | null = null;
    let firstError: unknown = null;
    for (const name of sheets) {
      try {
        first = inspectSheet(wb, name);
        if (first.totalRows > 0) break;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (!first) throw firstError ?? new WorkbookError("No worksheet with a header row and test cases was found.");
    const draftId = randomUUID();
    await deps.storage.put(draftKey(draftId), file.bytes);
    return { ok: true, value: { draftId, fileName: file.fileName, sourceKind: file.kind, sourceName: file.sourceName, sheets, sheet: first } };
  } catch (error) {
    return fail(error);
  }
}

async function loadDraft(deps: ExternalTestDeps, draftId: string) {
  if (!DRAFT_ID.test(draftId)) throw new SourceError("The uploaded workbook could not be found. Load it again.");
  const bytes = await deps.storage.get(draftKey(draftId));
  if (!bytes) throw new SourceError("The uploaded workbook is no longer available. Load it again.");
  return { bytes, wb: await loadWorkbook(bytes) };
}

export async function inspectDraftSheet(deps: ExternalTestDeps, draftId: string, sheetName: string, mapping?: ColumnMapping): Promise<Result<SheetInspection>> {
  try {
    const { wb } = await loadDraft(deps, draftId);
    return { ok: true, value: inspectSheet(wb, sheetName, mapping) };
  } catch (error) {
    return fail(error);
  }
}

export interface StartInput {
  draftId: string;
  sourceKind: SourceKind;
  sourceName: string;
  fileName: string;
  websiteUrl: string;
  /** Existing project, or null to reuse the project for this website (or create one). */
  projectId: string | null;
  name: string | null;
  sheetName: string;
  mapping: ColumnMapping;
  browsers: string[];
  viewports: string[];
  outputMode: OutputMode;
  allowFormSubmission: boolean;
}

/** Validates everything again on the server, then creates the execution and queues it for the worker. */
export async function startExternalExecution(deps: ExternalTestDeps, input: StartInput): Promise<Result<{ runId: string }>> {
  const url = normalizeWebsiteUrl(input.websiteUrl);
  if (!url.ok) return { ok: false, error: url.error };
  const browsers = BROWSERS.filter((b) => input.browsers.includes(b)) as BrowserName[];
  const viewports = ALL_VIEWPORTS.filter((v) => input.viewports.includes(v.id)).map((v) => v.id);
  if (!browsers.length) return { ok: false, error: "Select at least one browser." };
  if (!viewports.length) return { ok: false, error: "Select at least one device." };
  if (input.outputMode !== "EXISTING_SHEET" && input.outputMode !== "NEW_SHEET") return { ok: false, error: "Choose where the results are written." };
  const mapping: ColumnMapping = {};
  for (const f of CASE_FIELDS) {
    const v = input.mapping[f];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) mapping[f] = v;
  }

  let draft;
  let sheet;
  try {
    draft = await loadDraft(deps, input.draftId);
    sheet = readSheet(draft.wb, input.sheetName);
  } catch (error) {
    return fail(error);
  }
  const validation = validateMapping(mapping, sheet.columns);
  if (!validation.ok) return { ok: false, error: validation.errors.join(" ") };
  const cases = toCases(sheet, mapping);
  if (!cases.length) return { ok: false, error: "The selected worksheet has no test cases in the mapped Test Case / Scenario column." };

  // The website must be reachable before any browser work is queued (same HTTP client as the crawler).
  const probe = await (deps.fetcher ?? fetchUrl)(url.url, { timeoutMs: 15_000 });
  if (probe.error || probe.status === null) return { ok: false, error: `The website could not be reached: ${probe.error?.message ?? "no response"}.` };
  if (probe.status >= 400) return { ok: false, error: `The website responded with HTTP ${probe.status}. Check the URL.` };

  let projectId = input.projectId;
  if (projectId) {
    if (!(await deps.db.projects.getById(projectId))) return { ok: false, error: "The selected project no longer exists." };
  } else {
    const existing = (await deps.db.projects.list({ sort: "name" })).find((p) => isSameSite(p.websiteUrl, url.url) && new URL(p.websiteUrl).hostname === new URL(url.url).hostname);
    if (existing) projectId = existing.id;
    else {
      const created = await createProject({ db: deps.db, storage: deps.storage, maxUploadBytes: deps.maxUploadBytes }, { name: new URL(url.url).hostname.replace(/^www\./, ""), websiteUrl: url.url, description: "Created by External Test Case Testing.", figmaUrl: "", testEmail: "" }, null);
      if (!created.ok) return { ok: false, error: Object.values(created.errors).join(" ") || "The project could not be created." };
      projectId = created.project.id;
    }
  }

  const { page } = await deps.db.pages.addManual(projectId, url.url, normalizeCrawlUrl(url.url) ?? url.url);
  // The source workbook lives with the project (deleted with it); the draft copy is removed.
  const storageKey = `projects/${projectId}/external-test-cases/${randomUUID()}.xlsx`;
  await deps.storage.put(storageKey, draft.bytes);
  await deps.storage.deletePrefix(`external-drafts/${input.draftId}`);

  const runId = await deps.db.externalTests.create({
    projectId,
    name: input.name?.trim().slice(0, 100) || `${input.fileName} · ${sheet.name}`,
    websiteUrl: url.url,
    pageId: page.id,
    source: { kind: input.sourceKind, name: input.sourceName.slice(0, 200), storageKey },
    worksheet: sheet.name,
    headerRow: sheet.headerRow,
    mapping,
    outputMode: input.outputMode,
    browsers,
    viewports,
    allowFormSubmission: input.allowFormSubmission,
    navigationTimeoutMs: 30_000,
    cases,
  });
  await deps.db.activity.record({
    projectId,
    entityType: "test_run",
    entityId: runId,
    action: "created",
    summary: `External test cases queued: ${cases.length} case(s) from “${input.fileName}” (${sheet.name}) × ${browsers.length} browser(s) × ${viewports.length} device profile(s)`,
  });
  return { ok: true, value: { runId } };
}
