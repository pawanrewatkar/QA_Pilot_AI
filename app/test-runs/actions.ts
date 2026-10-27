"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionDb } from "@/lib/server/db";
import { createTestRun } from "@/lib/services/engine";
import type { TestRunFieldErrors } from "@/lib/validation/test-run";

// Every action resolves the trusted identity through actionDb() (owner-scoped data access; redirects when there is none).

export interface TestRunFormState {
  errors: TestRunFieldErrors;
}

export async function createTestRunAction(_prev: TestRunFormState, payload: unknown): Promise<TestRunFormState> {
  const result = await createTestRun(actionDb(), payload);
  if (!result.ok) return { errors: result.errors };
  revalidatePath("/test-runs");
  revalidatePath("/");
  redirect(`/test-runs/${result.run.id}`);
}

export async function cancelTestRunAction(formData: FormData): Promise<void> {
  const id = String(formData.get("testRunId") ?? "");
  if (id) {
    const db = actionDb();
    const run = await db.testRuns.getById(id);
    if (await db.testRuns.requestCancel(id)) {
      await db.activity.record({ projectId: run?.projectId ?? null, entityType: "test_run", entityId: id, action: "cancel-requested", summary: "Cancellation requested for a test run" });
    }
  }
  revalidatePath(`/test-runs/${id}`);
  revalidatePath("/test-runs");
}
