import "server-only";
import { authProvider } from "@/lib/auth/identity";
import { readEnv, resolveFromRoot } from "@/lib/config/env";

/**
 * The server folder from which "Local file path" workbooks may be read (EXTERNAL_TEST_CASES_DIR), or null
 * when that source is disabled.
 *
 * The folder is shared by everyone using the instance and has no per-user ownership, so it is only offered in
 * local single-operator mode (AUTH_PROVIDER=local, the default). With accounts (AUTH_PROVIDER=supabase), or
 * any unrecognised provider, it is disabled: users must upload the workbook or use a Google Drive link, which
 * are stored per owner.
 */
export function sharedWorkbookFolder(env: Record<string, string | undefined> = process.env): string | null {
  if (authProvider(env) !== "local") return null;
  return resolveFromRoot(readEnv(env).EXTERNAL_TEST_CASES_DIR);
}
