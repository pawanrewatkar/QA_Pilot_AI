import type { AppEnv } from "@/lib/config/env";

/**
 * Settings the worker checks before it starts. On GitHub Actions the machine is discarded after the run, so the
 * database and the artifact storage must be hosted: a local SQLite file or local files would silently lose every result.
 * Returns the problems (empty when the worker may start); messages name settings, never values.
 */
export function workerStartupProblems(env: Pick<AppEnv, "DATABASE_PROVIDER" | "STORAGE_PROVIDER">, runner: { githubActions: boolean }): string[] {
  if (!runner.githubActions) return [];
  const problems: string[] = [];
  if (env.DATABASE_PROVIDER !== "supabase") problems.push("On GitHub Actions the worker needs DATABASE_PROVIDER=supabase: a local SQLite file is discarded with the runner.");
  if (env.STORAGE_PROVIDER !== "supabase") problems.push("On GitHub Actions the worker needs STORAGE_PROVIDER=supabase: local files (screenshots, reports) are discarded with the runner.");
  return problems;
}

/**
 * A log line for a runner whose logs may be visible to others (GitHub Actions logs of a public repository are public):
 * web addresses of tested sites are replaced with `<url>`. Full details stay in the database, shown only to the owner.
 */
export function publicLogLine(message: string): string {
  return message.replace(/\b(?:https?|wss?|ftp):\/\/[^\s"'<>)\]]+/gi, "<url>");
}

/**
 * When the worker stops claiming new jobs (milliseconds since the epoch), or null for no limit. The job in progress
 * always finishes; this keeps a time-limited runner (e.g. a GitHub Actions job timeout) from killing the worker mid-job.
 */
export function claimDeadline(maxRuntimeMinutes: number | undefined, startedAt = Date.now()): number | null {
  return maxRuntimeMinutes ? startedAt + maxRuntimeMinutes * 60_000 : null;
}
