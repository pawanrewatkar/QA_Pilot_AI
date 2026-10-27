import { LOCAL_OWNER_ID } from "./identity-constants";

/**
 * The trusted, server-side identity of the current request.
 *
 * Only two sources exist:
 * - "local": the single local operator, for development on the operator's own machine;
 * - "supabase": reserved for Supabase Auth (a later step). Until it is implemented every request is
 *   unauthenticated, so a hosted deployment fails closed instead of exposing data.
 *
 * Nothing here reads cookies, headers, query strings or form data: a browser can never choose an identity.
 */
export interface Identity {
  /** Stable owner id stored in projects.owner_id. Local: LOCAL_OWNER_ID. Supabase: auth.users.id (UUID). */
  ownerId: string;
  source: "local";
}

export type IdentityFailure = "AUTH_NOT_IMPLEMENTED" | "LOCAL_MODE_NOT_ALLOWED" | "INVALID_AUTH_CONFIG";
export type IdentityResult = { ok: true; identity: Identity } | { ok: false; reason: IdentityFailure };

export const AUTH_PROVIDERS = ["local", "supabase"] as const;
export type AuthProviderName = (typeof AUTH_PROVIDERS)[number];

export { LOCAL_OWNER_ID };

export const IDENTITY_FAILURE_MESSAGES: Record<IdentityFailure, string> = {
  AUTH_NOT_IMPLEMENTED: "Sign-in (Supabase Auth) is selected but not implemented yet, so every request is treated as signed out.",
  LOCAL_MODE_NOT_ALLOWED:
    "Local single-user mode is only allowed on the operator's own machine: never on Vercel, and for production builds only with QA_PILOT_LOCAL_MODE=true.",
  INVALID_AUTH_CONFIG: "AUTH_PROVIDER has an unsupported value.",
};

/**
 * Resolves the identity from server configuration only. Rules (all fail closed):
 * - AUTH_PROVIDER must be "local" (default) or "supabase"; anything else is invalid.
 * - "supabase" → unauthenticated until Supabase Auth is implemented.
 * - "local" is refused on Vercel (VERCEL is set) under all circumstances.
 * - "local" with a production build (NODE_ENV=production, e.g. `next start`) needs the explicit
 *   opt-in QA_PILOT_LOCAL_MODE=true, so a production build is never single-user by accident.
 */
export function resolveIdentity(env: Record<string, string | undefined> = process.env): IdentityResult {
  const raw = (env.AUTH_PROVIDER ?? "").trim();
  const provider = raw === "" ? "local" : raw;
  if (!(AUTH_PROVIDERS as readonly string[]).includes(provider)) return { ok: false, reason: "INVALID_AUTH_CONFIG" };
  if (provider === "supabase") return { ok: false, reason: "AUTH_NOT_IMPLEMENTED" };
  if (env.VERCEL) return { ok: false, reason: "LOCAL_MODE_NOT_ALLOWED" };
  if (env.NODE_ENV === "production" && env.QA_PILOT_LOCAL_MODE !== "true") return { ok: false, reason: "LOCAL_MODE_NOT_ALLOWED" };
  return { ok: true, identity: { ownerId: LOCAL_OWNER_ID, source: "local" } };
}
