"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDatabase } from "@/lib/database";
import { bundlePrefix } from "@/lib/reports/paths";
import { getStorage } from "@/lib/storage";

// No authentication in this local-first phase; add an auth check here before shared deployment.

export async function generateReportAction(formData: FormData): Promise<void> {
  const runId = String(formData.get("testRunId") ?? "");
  if (!runId) return;
  const db = getDatabase();
  let requested = false;
  try {
    const bundle = await db.reports.requestBundle(runId);
    await db.activity.record({ projectId: bundle.projectId, entityType: "report", entityId: bundle.id, action: "created", summary: `Report requested: ${bundle.name}` });
    requested = true;
  } catch {
    // Unfinished or missing runs are rejected by the repository; the page shows the run's state.
  }
  revalidatePath("/reports");
  revalidatePath(`/test-runs/${runId}`);
  if (requested) redirect("/reports");
}

export async function deleteReportAction(formData: FormData): Promise<void> {
  const id = String(formData.get("bundleId") ?? "");
  if (!id) return;
  const db = getDatabase();
  const bundle = await db.reports.getBundle(id);
  if (!bundle) return;
  await db.reports.deleteBundle(id);
  await getStorage().deletePrefix(bundlePrefix(id));
  await db.activity.record({ projectId: bundle.projectId, entityType: "report", entityId: id, action: "deleted", summary: `Report deleted: ${bundle.name}` });
  revalidatePath("/reports");
}
