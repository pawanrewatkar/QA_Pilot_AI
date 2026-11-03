import "server-only";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { authProvider, type Identity, type IdentityResult } from "@/lib/auth/identity";
import { getRequestIdentity } from "@/lib/auth/request-identity";
import { getDatabase } from "@/lib/database";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import type { DatabaseProvider } from "@/lib/database/provider";

/**
 * Authorized data access for the web app. Every page, server action and route handler gets its data
 * through one of these helpers: they resolve the trusted server-side identity (a verified Supabase session,
 * or the local operator in local mode) and return a provider scoped to that owner
 * (lib/database/owner-scoped-provider.ts). The unscoped provider is for the worker and tests only.
 */

/** Public page explaining why no identity is available (local mode not allowed, misconfiguration). */
export const AUTH_REQUIRED_PATH = "/auth-required";
export const LOGIN_PATH = "/login";

function scoped(identity: Identity): DatabaseProvider {
  return new OwnerScopedDatabaseProvider(getDatabase(), identity.ownerId);
}

/** Where to send a browser without an identity: the login page in Supabase mode, otherwise the explanation page. */
function signInRedirect(result: Extract<IdentityResult, { ok: false }>): never {
  const toLogin = authProvider() === "supabase" && result.reason !== "SUPABASE_NOT_CONFIGURED";
  redirect(toLogin ? LOGIN_PATH : AUTH_REQUIRED_PATH);
}

/**
 * For Server Components. better-sqlite3 is synchronous, so without `connection()` Next.js would run these
 * queries once at build time and serve stale data. Redirects when there is no identity.
 */
export async function requestDb(): Promise<DatabaseProvider> {
  await connection();
  const result = await getRequestIdentity();
  if (!result.ok) signInRedirect(result);
  return scoped(result.identity);
}

/** For Server Actions (treated as public endpoints): redirects when there is no identity. */
export async function actionDb(): Promise<DatabaseProvider> {
  const result = await getRequestIdentity();
  if (!result.ok) signInRedirect(result);
  return scoped(result.identity);
}

/** Identity for server-side work that needs it directly (e.g. per-owner storage keys). Redirects without identity. */
export async function actionIdentity(): Promise<Identity> {
  const result = await getRequestIdentity();
  if (!result.ok) signInRedirect(result);
  return result.identity;
}

/** For Route Handlers: the scoped provider, or a JSON 401 response to return as is. */
export async function routeDb(): Promise<{ db: DatabaseProvider; identity: Identity; denied?: undefined } | { denied: Response }> {
  const result = await getRequestIdentity();
  if (!result.ok) return { denied: unauthorized() };
  return { db: scoped(result.identity), identity: result.identity };
}

export function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

export function notFound(message = "Not found"): Response {
  return Response.json({ error: message }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
