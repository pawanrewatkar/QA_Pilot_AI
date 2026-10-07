"use server";

import { revalidatePath } from "next/cache";
import { getDatabase } from "@/lib/database";
import { BUG_STATUSES, type BugStatus } from "@/types";

// No authentication in this local-first phase; add an auth check here before shared deployment.

export async function updateBugStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get("bugId") ?? "");
  const status = BUG_STATUSES.find((s) => s === formData.get("status")) as BugStatus | undefined;
  const note = String(formData.get("note") ?? "").trim().slice(0, 1000) || null;
  if (!id || !status) return;
  const db = getDatabase();
  const bug = await db.bugs.updateStatus(id, status, note);
  if (bug) {
    await db.activity.record({ projectId: bug.projectId, entityType: "bug", entityId: id, action: "updated", summary: `${bug.code ?? "Bug"} status set to ${status.replace(/_/g, " ")}` });
  }
  revalidatePath(`/bugs/${id}`);
  revalidatePath("/bugs");
  revalidatePath("/");
}

export async function createBugsFromRunAction(formData: FormData): Promise<void> {
  const runId = String(formData.get("testRunId") ?? "");
  if (!runId) return;
  const db = getDatabase();
  const run = await db.testRuns.getById(runId);
  if (!run || run.status === "PENDING" || run.status === "RUNNING") return;
  const summary = await db.bugs.createFromRun(runId);
  await db.activity.record({
    projectId: run.projectId,
    entityType: "bug",
    entityId: runId,
    action: "created",
    summary: `Bug engine processed ${summary.failures} verified failure(s): ${summary.created} new, ${summary.updated} recurring, ${summary.reopened} reopened`,
  });
  revalidatePath(`/test-runs/${runId}`);
  revalidatePath("/bugs");
  revalidatePath("/");
}
