import "server-only";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { resolveIdentity, type Identity } from "@/lib/auth/identity";
import { getDatabase } from "@/lib/database";
import { OwnerScopedDatabaseProvider } from "@/lib/database/owner-scoped-provider";
import type { DatabaseProvider } from "@/lib/database/provider";

/**
 * Authorized data access for the web app. Every page, server action and route handler gets its data
 * through one of these helpers: they resolve the trusted server-side identity and return a provider scoped
 * to that owner (lib/database/owner-scoped-provider.ts). The unscoped provider is for the worker and tests.
 */

/** Public page shown when no identity is available (sign-in not configured or local mode not allowed). */
export const AUTH_REQUIRED_PATH = "/auth-required";

function scoped(identity: Identity): DatabaseProvider {
  return new OwnerScopedDatabaseProvider(getDatabase(), identity.ownerId);
}

/**
 * For Server Components. better-sqlite3 is synchronous, so without `connection()` Next.js would run these
 * queries once at build time and serve stale data. Redirects when there is no identity.
 */
export async function requestDb(): Promise<DatabaseProvider> {
  await connection();
  const result = resolveIdentity();
  if (!result.ok) redirect(AUTH_REQUIRED_PATH);
  return scoped(result.identity);
}

/** For Server Actions (treated as public endpoints): redirects when there is no identity. */
export function actionDb(): DatabaseProvider {
  const result = resolveIdentity();
  if (!result.ok) redirect(AUTH_REQUIRED_PATH);
  return scoped(result.identity);
}

/** Owner id for server-side work that needs it directly (e.g. per-owner storage keys). Redirects without identity. */
export function actionIdentity(): Identity {
  const result = resolveIdentity();
  if (!result.ok) redirect(AUTH_REQUIRED_PATH);
  return result.identity;
}

/** For Route Handlers: the scoped provider, or a JSON 401 response to return as is. */
export function routeDb(): { db: DatabaseProvider; identity: Identity; denied?: undefined } | { denied: Response } {
  const result = resolveIdentity();
  if (!result.ok) return { denied: unauthorized() };
  return { db: scoped(result.identity), identity: result.identity };
}

export function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

export function notFound(message = "Not found"): Response {
  return Response.json({ error: message }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
