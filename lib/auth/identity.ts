import { isEmailAllowed, normalizeEmail, parseAllowList } from "./allow-list";
import { LOCAL_OWNER_ID } from "./identity-constants";
import { readSupabaseAuthConfig, type SupabaseAuthConfig } from "./supabase-config";

/**
 * The trusted, server-side identity of the current request.
 *
 * Two sources exist:
 * - "local": the single local operator, for development on the operator's own machine;
 * - "supabase": a Supabase Auth user, taken only from a session verified with the Auth server
 *   (lib/auth/request-identity.ts) and accepted only if the email is confirmed and allow-listed.
 *
 * Nothing here reads request parameters, form fields or client headers: a browser can never choose an identity.
 */
export interface Identity {
  /** Stable owner id stored in projects.owner_id. Local: LOCAL_OWNER_ID. Supabase: auth.users.id (UUID). */
  ownerId: string;
  source: "local" | "supabase";
  /** Normalized email (Supabase identities only). */
  email?: string;
}

export type IdentityFailure =
  | "LOCAL_MODE_NOT_ALLOWED"
  | "INVALID_AUTH_CONFIG"
  | "SUPABASE_NOT_CONFIGURED"
  | "UNAUTHENTICATED"
  | "EMAIL_NOT_CONFIRMED"
  | "NOT_ALLOWED"
  | "INVALID_USER";
export type IdentityResult = { ok: true; identity: Identity } | { ok: false; reason: IdentityFailure };

/** What the configuration allows before any session is looked at. */
export type IdentityConfig =
  | { ok: true; mode: "local"; identity: Identity }
  | { ok: true; mode: "supabase"; config: SupabaseAuthConfig }
  | { ok: false; reason: Extract<IdentityFailure, "LOCAL_MODE_NOT_ALLOWED" | "INVALID_AUTH_CONFIG" | "SUPABASE_NOT_CONFIGURED"> };

export const AUTH_PROVIDERS = ["local", "supabase"] as const;
export type AuthProviderName = (typeof AUTH_PROVIDERS)[number];

export { LOCAL_OWNER_ID };

export const IDENTITY_FAILURE_MESSAGES: Record<IdentityFailure, string> = {
  LOCAL_MODE_NOT_ALLOWED:
    "Local single-user mode is only allowed on the operator's own machine: never on Vercel, and for production builds only with QA_PILOT_LOCAL_MODE=true.",
  INVALID_AUTH_CONFIG: "AUTH_PROVIDER has an unsupported value.",
  SUPABASE_NOT_CONFIGURED: "Supabase Auth is selected but not fully configured on the server, so sign-in is disabled.",
  UNAUTHENTICATED: "You are not signed in.",
  EMAIL_NOT_CONFIRMED: "This account's email address has not been confirmed.",
  NOT_ALLOWED: "This account is not permitted to use this instance.",
  INVALID_USER: "The signed-in account could not be verified.",
};

/** The selected provider ("local" when unset). Unknown values are returned as null (invalid). */
export function authProvider(env: Record<string, string | undefined> = process.env): AuthProviderName | null {
  const raw = (env.AUTH_PROVIDER ?? "").trim();
  const provider = raw === "" ? "local" : raw;
  return (AUTH_PROVIDERS as readonly string[]).includes(provider) ? (provider as AuthProviderName) : null;
}

/**
 * Configuration rules (all fail closed):
 * - AUTH_PROVIDER must be "local" (default) or "supabase"; anything else is invalid.
 * - "local" is refused on Vercel (VERCEL is set), and for production builds (NODE_ENV=production) unless
 *   QA_PILOT_LOCAL_MODE is exactly "true".
 * - "supabase" needs a valid Supabase configuration; when it is missing nothing falls back to local mode.
 */
export function resolveIdentityConfig(env: Record<string, string | undefined> = process.env): IdentityConfig {
  const provider = authProvider(env);
  if (provider === null) return { ok: false, reason: "INVALID_AUTH_CONFIG" };
  if (provider === "supabase") {
    const cfg = readSupabaseAuthConfig(env);
    return cfg.ok ? { ok: true, mode: "supabase", config: cfg.config } : { ok: false, reason: "SUPABASE_NOT_CONFIGURED" };
  }
  if (env.VERCEL) return { ok: false, reason: "LOCAL_MODE_NOT_ALLOWED" };
  if (env.NODE_ENV === "production" && env.QA_PILOT_LOCAL_MODE !== "true") return { ok: false, reason: "LOCAL_MODE_NOT_ALLOWED" };
  return { ok: true, mode: "local", identity: { ownerId: LOCAL_OWNER_ID, source: "local" } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The subset of a Supabase Auth user this app relies on. */
export interface VerifiedUserLike {
  id?: unknown;
  email?: unknown;
  email_confirmed_at?: unknown;
}

/**
 * Turns a user returned by a *server-verified* Supabase session into an identity. The user must have a
 * UUID id, a confirmed email, and an email that is on the AUTH_ALLOWED_EMAILS allow-list right now (so
 * removing an address from the list revokes access, and accounts created outside the app are refused).
 */
export function identityFromVerifiedUser(user: VerifiedUserLike | null | undefined, env: Record<string, string | undefined> = process.env): IdentityResult {
  if (!user) return { ok: false, reason: "UNAUTHENTICATED" };
  if (typeof user.id !== "string" || !UUID.test(user.id) || user.id === LOCAL_OWNER_ID) return { ok: false, reason: "INVALID_USER" };
  const email = normalizeEmail(user.email);
  if (!email) return { ok: false, reason: "INVALID_USER" };
  if (typeof user.email_confirmed_at !== "string" || Number.isNaN(Date.parse(user.email_confirmed_at))) return { ok: false, reason: "EMAIL_NOT_CONFIRMED" };
  if (!isEmailAllowed(email, parseAllowList(env.AUTH_ALLOWED_EMAILS))) return { ok: false, reason: "NOT_ALLOWED" };
  return { ok: true, identity: { ownerId: user.id.toLowerCase(), source: "supabase", email } };
}
