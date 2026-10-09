import { findViewport, VIEWPORT_KIND_LABELS } from "@/lib/constants/testing";
import type { SqliteDatabase } from "@/lib/database/local/sqlite-client";
import type { StorageProvider } from "@/lib/storage/provider";
import { externalResultFileName, writeResults, type RowResult } from "./writer";
import { aggregateStatus } from "./status";
import type { ColumnMapping, ExternalStatus, OutputMode } from "./types";

type Row = Record<string, unknown>;

export { aggregateStatus };

const comboLabel = (browser: string, viewport: string) => {
  const v = findViewport(viewport);
  return `${v ? `${VIEWPORT_KIND_LABELS[v.kind]} ${v.width}×${v.height}` : viewport} · ${browser}`;
};

export function aggregateActual(observations: { browser: string; viewport: string; status: ExternalStatus; actual: string }[]): string {
  if (observations.length === 1) return observations[0].actual;
  return observations.map((o) => `[${comboLabel(o.browser, o.viewport)}] ${o.status}: ${o.actual}`).join("\n");
}

export const externalOutputPrefix = (runId: string) => `runs/${runId}/external`;

/**
 * After the browser work: decides each case's status across browsers/devices, links observations to
 * the standard results (evidence, bugs), and writes the result workbook. Never throws; a workbook
 * error is stored on the execution and shown in the UI.
 */
export async function finalizeExternalRun(db: SqliteDatabase, storage: StorageProvider, runId: string, reason: string | null = null): Promise<void> {
  const exec = db.prepare("SELECT * FROM external_test_executions WHERE test_run_id = ?").get(runId) as Row | undefined;
  if (!exec) return;
  const cases = db.prepare("SELECT * FROM external_test_cases WHERE test_run_id = ? ORDER BY row_number").all(runId) as Row[];
  const observations = db.prepare("SELECT * FROM external_test_observations WHERE test_run_id = ? ORDER BY observed_at").all(runId) as Row[];

  // Observation ↔ standard test result (same case key, browser and viewport).
  db.prepare(
    `UPDATE external_test_observations AS o SET test_result_id = (
       SELECT tr.id FROM test_results tr JOIN test_cases tc ON tc.id = tr.test_case_id JOIN external_test_cases c ON c.id = o.external_case_id
       WHERE tr.test_run_id = o.test_run_id AND tc.module = 'external' AND tc.case_key LIKE '%|external:row-' || c.row_number
         AND tr.browser = o.browser AND tr.viewport = o.viewport
       ORDER BY tr.created_at DESC LIMIT 1)
     WHERE o.test_run_id = ?`,
  ).run(runId);

  const results: RowResult[] = [];
  const update = db.prepare("UPDATE external_test_cases SET status = ?, actual_result = ?, executed_at = ? WHERE id = ?");
  db.transaction(() => {
    for (const c of cases) {
      const obs = observations
        .filter((o) => o.external_case_id === c.id)
        .map((o) => ({ browser: String(o.browser), viewport: String(o.viewport), status: String(o.status) as ExternalStatus, actual: String(o.actual_result), at: String(o.observed_at) }));
      const status = obs.length ? aggregateStatus(obs.map((o) => o.status)) : "NOT EXECUTED";
      const actual = obs.length ? aggregateActual(obs) : (reason ?? "This test case was not executed because the website could not be tested in any selected browser or device (see the run's page-load result).");
      const executedAt = obs.length ? obs[obs.length - 1].at : new Date().toISOString();
      update.run(status, actual.slice(0, 32_000), executedAt, c.id);
      results.push({ rowNumber: Number(c.row_number), status, actual: actual.slice(0, 32_000), executedAt: new Date(executedAt) });
    }
  })();

  try {
    const source = await storage.get(String(exec.source_storage_key));
    if (!source) throw new Error("The uploaded workbook is no longer in storage.");
    const mapping = JSON.parse(String(exec.mapping)) as ColumnMapping;
    const out = await writeResults(source, {
      sheetName: String(exec.worksheet),
      headerRow: Number(exec.header_row),
      mode: String(exec.output_mode) as OutputMode,
      results,
      mappedColumns: Object.values(mapping).filter((v): v is number => typeof v === "number"),
    });
    const fileName = externalResultFileName(String(exec.website_url), new Date());
    const key = `${externalOutputPrefix(runId)}/${fileName}`;
    await storage.put(key, out.bytes, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    db.prepare("UPDATE external_test_executions SET output_storage_key = ?, output_file_name = ?, result_columns = ?, output_error = NULL WHERE test_run_id = ?").run(
      key,
      fileName,
      JSON.stringify({ sheet: out.sheet, set: out.columns.set, actual: out.columns.actual.header, status: out.columns.status.header, date: out.columns.date.header }),
      runId,
    );
  } catch (error) {
    db.prepare("UPDATE external_test_executions SET output_error = ? WHERE test_run_id = ?").run(`The result workbook could not be written: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000), runId);
  }
}
