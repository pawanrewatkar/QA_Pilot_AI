import type { AppEnv } from "./env";

/**
 * Settings the web app needs on Vercel. Its file system is read-only and discarded per instance, so the defaults (a
 * local SQLite file, local files) cannot work there: the hosted database and storage must be selected explicitly.
 * Returns the problems (empty when allowed); messages name settings, never values. Local development is unaffected.
 */
export function deploymentProblems(env: Pick<AppEnv, "DATABASE_PROVIDER" | "STORAGE_PROVIDER">, runtime: { vercel: boolean }): string[] {
  if (!runtime.vercel) return [];
  const problems: string[] = [];
  if (env.DATABASE_PROVIDER !== "supabase") problems.push("On Vercel the app needs DATABASE_PROVIDER=supabase (PostgreSQL): a local SQLite file cannot be used there.");
  if (env.STORAGE_PROVIDER !== "supabase") problems.push("On Vercel the app needs STORAGE_PROVIDER=supabase (private bucket): local files cannot be used there.");
  return problems;
}

/** Throws with every problem when the configuration cannot work in this deployment. */
export function assertDeployable(env: Pick<AppEnv, "DATABASE_PROVIDER" | "STORAGE_PROVIDER">, source: Record<string, string | undefined> = process.env): void {
  const problems = deploymentProblems(env, { vercel: !!source.VERCEL });
  if (problems.length) throw new Error(`Invalid deployment configuration: ${problems.join(" ")}`);
}
