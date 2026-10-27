/**
 * Supabase Auth configuration (server-side validation).
 *
 * Only public values are needed: the project URL and the publishable (or legacy anon) key, which are
 * designed to be exposed, plus the site origin used to build email links. No service-role or secret key is
 * used by authentication. If AUTH_PROVIDER=supabase is selected but this configuration is missing or invalid,
 * authentication is refused (fail closed); it never falls back to local mode.
 */
export interface SupabaseAuthConfig {
  url: string;
  publishableKey: string;
  /** Canonical origin of this app (no trailing slash), used for emailRedirectTo / redirectTo. Never taken from request headers. */
  siteUrl: string;
}

export type SupabaseConfigResult = { ok: true; config: SupabaseAuthConfig } | { ok: false; missing: string[] };

const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** An http(s) origin; plain http only for loopback addresses (local Supabase / local app). */
function validOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export function readSupabaseAuthConfig(env: Record<string, string | undefined> = process.env): SupabaseConfigResult {
  const url = validOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  const key = (env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  const siteUrl = validOrigin(env.NEXT_PUBLIC_SITE_URL);
  const missing: string[] = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  // Publishable keys start with "sb_publishable_"; legacy anon keys are JWTs. A secret key must never be used here.
  if (!key || /^sb_secret_/.test(key) || /\s/.test(key) || key.length < 20) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (!siteUrl) missing.push("NEXT_PUBLIC_SITE_URL");
  if (missing.length) return { ok: false, missing };
  return { ok: true, config: { url: url!, publishableKey: key, siteUrl: siteUrl! } };
}
