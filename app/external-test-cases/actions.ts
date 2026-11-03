"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { readEnv } from "@/lib/config/env";
import { sharedWorkbookFolder } from "@/lib/external-tests/shared-folder";
import { actionDb, actionIdentity } from "@/lib/server/db";
import type { ColumnMapping, OutputMode, SourceKind } from "@/lib/external-tests/types";
import { inspectDraftSheet, inspectSource, startExternalExecution, type DraftInspection, type ExternalTestDeps, type Result, type SheetInspection, type SourceInput } from "@/lib/services/external-tests";
import { getStorage } from "@/lib/storage";

// Every action resolves the trusted identity (owner-scoped data access; redirects when there is none).

async function deps(): Promise<ExternalTestDeps> {
  const env = readEnv();
  // Owner-scoped data access; drafts are stored per owner so one identity can never open another's upload.
  return { db: await actionDb(), ownerId: (await actionIdentity()).ownerId, storage: getStorage(), maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024, localDir: sharedWorkbookFolder() };
}

/** Step 1: load the workbook from an upload, a local path or a Google Drive link. */
export async function loadWorkbookAction(formData: FormData): Promise<Result<DraftInspection>> {
  const kind = String(formData.get("sourceKind") ?? "") as SourceKind;
  let input: SourceInput;
  if (kind === "UPLOAD") {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an Excel file to upload." };
    input = { kind, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  } else if (kind === "LOCAL_PATH") {
    input = { kind, path: String(formData.get("path") ?? "") };
  } else if (kind === "GOOGLE_DRIVE") {
    input = { kind, link: String(formData.get("link") ?? "") };
  } else {
    return { ok: false, error: "Choose a test-case source." };
  }
  return inspectSource(await deps(), input);
}

/** Step 2: another worksheet (or a corrected mapping) of the loaded workbook. */
export async function inspectSheetAction(draftId: string, sheetName: string, mapping?: ColumnMapping): Promise<Result<SheetInspection>> {
  return inspectDraftSheet(await deps(), draftId, sheetName, mapping);
}

export interface StartPayload {
  draftId: string;
  sourceKind: SourceKind;
  sourceName: string;
  fileName: string;
  websiteUrl: string;
  projectId: string | null;
  name: string | null;
  sheetName: string;
  mapping: ColumnMapping;
  browsers: string[];
  viewports: string[];
  outputMode: OutputMode;
  allowFormSubmission: boolean;
}

/** Final step: validates everything again, queues the execution and opens its page. */
export async function startExecutionAction(payload: StartPayload): Promise<{ error: string }> {
  const res = await startExternalExecution(await deps(), payload);
  if (!res.ok) return { error: res.error };
  revalidatePath("/external-test-cases");
  revalidatePath("/history");
  redirect(`/external-test-cases/${res.value.runId}`);
}
