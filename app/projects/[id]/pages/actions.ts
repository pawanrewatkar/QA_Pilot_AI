"use server";

import { revalidatePath } from "next/cache";
import { actionDb } from "@/lib/server/db";
import { addManualPages, startCrawl } from "@/lib/services/engine";
import type { CrawlFieldErrors } from "@/lib/validation/crawl";

// Every action resolves the trusted identity through actionDb() (owner-scoped data access; redirects when there is none).

export interface CrawlFormState {
  errors: CrawlFieldErrors;
  startedId: string | null;
}

export async function startCrawlAction(projectId: string, _prev: CrawlFormState, formData: FormData): Promise<CrawlFormState> {
  const raw = Object.fromEntries(
    ["maxDepth", "maxPages", "timeoutSeconds", "retries", "exclusions", "includeSubdomains", "respectRobotsTxt", "useSitemap", "queryParams"].map((k) => [k, formData.get(k)]),
  );
  const result = await startCrawl(actionDb(), projectId, raw);
  if (!result.ok) return { errors: result.errors, startedId: null };
  revalidatePath(`/projects/${projectId}/pages`);
  return { errors: {}, startedId: result.crawl.id };
}

export async function cancelCrawlAction(formData: FormData): Promise<void> {
  const id = String(formData.get("crawlRunId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  if (id) await actionDb().crawlRuns.requestCancel(id);
  revalidatePath(`/projects/${projectId}/pages`);
}

export async function setPagesSelectedAction(projectId: string, ids: string[], selected: boolean): Promise<{ changed: number }> {
  const safeIds = ids.filter((id) => typeof id === "string").slice(0, 5000);
  const changed = await actionDb().pages.setSelected(projectId, safeIds, selected);
  revalidatePath(`/projects/${projectId}/pages`);
  return { changed };
}

export interface ManualUrlState {
  error: string | null;
  message: string | null;
}

export async function addManualUrlsAction(projectId: string, _prev: ManualUrlState, formData: FormData): Promise<ManualUrlState> {
  const result = await addManualPages(actionDb(), projectId, String(formData.get("urls") ?? ""));
  if (!result.ok) return { error: result.error, message: null };
  revalidatePath(`/projects/${projectId}/pages`);
  revalidatePath("/pages");
  return { error: null, message: `${result.added} page${result.added === 1 ? "" : "s"} added${result.existing ? `, ${result.existing} already known` : ""}.` };
}
