"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDatabase } from "@/lib/database";
import { createTestRun } from "@/lib/services/engine";
import type { TestRunFieldErrors } from "@/lib/validation/test-run";

// No authentication in this local-first phase; add an auth check here before shared deployment.

export interface TestRunFormState {
  errors: TestRunFieldErrors;
}

export async function createTestRunAction(_prev: TestRunFormState, payload: unknown): Promise<TestRunFormState> {
  const result = await createTestRun(getDatabase(), payload);
  if (!result.ok) return { errors: result.errors };
  revalidatePath("/test-runs");
  revalidatePath("/");
  redirect(`/test-runs/${result.run.id}`);
}

export async function cancelTestRunAction(formData: FormData): Promise<void> {
  const id = String(formData.get("testRunId") ?? "");
  if (id) {
    const db = getDatabase();
    const run = await db.testRuns.getById(id);
    if (await db.testRuns.requestCancel(id)) {
      await db.activity.record({ projectId: run?.projectId ?? null, entityType: "test_run", entityId: id, action: "cancel-requested", summary: "Cancellation requested for a test run" });
    }
  }
  revalidatePath(`/test-runs/${id}`);
  revalidatePath("/test-runs");
}
