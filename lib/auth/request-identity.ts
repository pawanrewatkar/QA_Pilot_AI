import "server-only";
import { cache } from "react";
import { identityFromVerifiedUser, resolveIdentityConfig, type IdentityResult } from "./identity";
import { createSupabaseServerClient } from "./supabase-server";

/**
 * The identity of the current request, resolved once per request (React `cache`).
 *
 * Supabase mode uses `auth.getUser()`, which validates the session with the Supabase Auth server on every
 * request (unlike `getSession()`, which only decodes the cookie). The returned user must still have a
 * confirmed, allow-listed email (lib/auth/identity.ts). Any error yields "unauthenticated".
 */
export const getRequestIdentity = cache(async (): Promise<IdentityResult> => {
  const cfg = resolveIdentityConfig();
  if (!cfg.ok) return cfg;
  if (cfg.mode === "local") return { ok: true, identity: cfg.identity };
  try {
    const supabase = await createSupabaseServerClient(cfg.config);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { ok: false, reason: "UNAUTHENTICATED" };
    return identityFromVerifiedUser(data.user);
  } catch {
    return { ok: false, reason: "UNAUTHENTICATED" };
  }
});
