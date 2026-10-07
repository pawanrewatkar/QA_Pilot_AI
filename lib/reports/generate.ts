import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@/lib/database/local/sqlite-client";
import type { StorageProvider } from "@/lib/storage/provider";
import { loadReportData, reportFileNames, type ReportData } from "./data";
import { buildBugExcel, buildTestingExcel } from "./excel";
import { renderReportHtml } from "./html";
import type { PdfRenderer } from "./pdf";

export type ReportKind = "PDF" | "HTML" | "TESTING_EXCEL" | "BUG_EXCEL";
const FORMAT: Record<ReportKind, "PDF" | "HTML" | "EXCEL"> = { PDF: "PDF", HTML: "HTML", TESTING_EXCEL: "EXCEL", BUG_EXCEL: "EXCEL" };

export { bundlePrefix } from "./paths";
import { bundlePrefix } from "./paths";

/** Loads the screenshots a report embeds as data: URIs. Missing files are skipped, not invented. */
async function loadImages(storage: StorageProvider, data: ReportData): Promise<Map<string, string>> {
  const keys = new Set<string>(data.screenshots.map((s) => s.key));
  for (const b of data.bugs) if (b.screenshotKey) keys.add(b.screenshotKey);
  const images = new Map<string, string>();
  for (const key of keys) {
    const bytes = await storage.get(key).catch(() => null);
    if (bytes) images.set(key, `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
  }
  return images;
}

export interface BundleOutcome {
  status: "READY" | "FAILED";
  files: { kind: ReportKind; status: "READY" | "FAILED"; error?: string }[];
}

/**
 * Generates the four files of a report bundle. Each file is produced independently: a failure in
 * one (for example no Chromium for the PDF) is recorded on that file and does not hide the others.
 */
export async function generateReportBundle(db: SqliteDatabase, storage: StorageProvider, bundleId: string, pdf: PdfRenderer): Promise<BundleOutcome> {
  const bundle = db.prepare("SELECT * FROM report_bundles WHERE id = ?").get(bundleId) as Record<string, unknown> | undefined;
  if (!bundle) throw new Error(`Report bundle ${bundleId} not found`);
  const now = () => new Date().toISOString();
  const fail = (message: string): BundleOutcome => {
    db.prepare("UPDATE report_bundles SET status = 'FAILED', error_message = ?, completed_at = ? WHERE id = ?").run(message.slice(0, 2000), now(), bundleId);
    return { status: "FAILED", files: [] };
  };
  if (!bundle.test_run_id) return fail("The test run for this report no longer exists.");

  let data: ReportData;
  try {
    data = await loadReportData(db, String(bundle.test_run_id));
  } catch (error) {
    return fail(`Could not read the run's results: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Clear rows from an earlier attempt of the same bundle (job retries).
  db.prepare("DELETE FROM reports WHERE bundle_id = ?").run(bundleId);

  const names = reportFileNames(data.project.websiteUrl, new Date(data.run.completedAt ?? data.run.createdAt));
  const images = await loadImages(storage, data);
  const builders: { kind: ReportKind; fileName: string; build: () => Promise<Uint8Array> }[] = [
    { kind: "TESTING_EXCEL", fileName: names.testingExcel, build: () => buildTestingExcel(data) },
    { kind: "BUG_EXCEL", fileName: names.bugExcel, build: () => buildBugExcel(data) },
    { kind: "HTML", fileName: names.html, build: async () => new TextEncoder().encode(renderReportHtml(data, { mode: "standalone", images })) },
    { kind: "PDF", fileName: names.pdf, build: () => pdf.render(renderReportHtml(data, { mode: "print", images })) },
  ];

  const files: BundleOutcome["files"] = [];
  for (const b of builders) {
    const id = randomUUID();
    const key = `${bundlePrefix(bundleId)}/${b.fileName}`;
    try {
      const bytes = await b.build();
      await storage.put(key, bytes);
      db.prepare(
        `INSERT INTO reports (id, project_id, test_run_id, format, status, storage_key, file_name, size_bytes, created_at, completed_at, bundle_id, kind)
         VALUES (?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, bundle.project_id, bundle.test_run_id, FORMAT[b.kind], key, b.fileName, bytes.byteLength, now(), now(), bundleId, b.kind);
      files.push({ kind: b.kind, status: "READY" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(
        `INSERT INTO reports (id, project_id, test_run_id, format, status, file_name, error_message, created_at, completed_at, bundle_id, kind)
         VALUES (?, ?, ?, ?, 'FAILED', ?, ?, ?, ?, ?, ?)`,
      ).run(id, bundle.project_id, bundle.test_run_id, FORMAT[b.kind], b.fileName, message.slice(0, 2000), now(), now(), bundleId, b.kind);
      files.push({ kind: b.kind, status: "FAILED", error: message });
    }
  }
  const failed = files.filter((f) => f.status === "FAILED");
  const status = failed.length === files.length ? "FAILED" : "READY";
  db.prepare("UPDATE report_bundles SET status = ?, error_message = ?, completed_at = ? WHERE id = ?").run(
    status,
    failed.length ? failed.map((f) => `${f.kind}: ${f.error}`).join("\n").slice(0, 2000) : null,
    now(),
    bundleId,
  );
  db.prepare("INSERT INTO activity_log (id, project_id, entity_type, entity_id, action, summary, created_at) VALUES (?, ?, 'report', ?, ?, ?, ?)").run(
    randomUUID(),
    bundle.project_id,
    bundleId,
    status === "READY" ? "report.generated" : "report.failed",
    status === "READY" ? `Report "${String(bundle.name)}" generated${failed.length ? ` (${failed.length} file(s) failed)` : ""}` : `Report "${String(bundle.name)}" failed`,
    now(),
  );
  return { status, files };
}
