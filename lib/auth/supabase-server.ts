import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseAuthConfig } from "./supabase-config";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers, bound to the request cookies.
 *
 * The session lives only in cookies. This app never creates a browser Supabase client, so the session
 * cookies are httpOnly (not readable by page scripts), sameSite=lax and secure outside local development.
 * Server Components cannot write cookies; there `setAll` is ignored and proxy.ts performs the refresh.
 */
export async function createSupabaseServerClient(config: SupabaseAuthConfig) {
  const store = await cookies();
  return createServerClient(config.url, config.publishableKey, {
    cookieOptions: authCookieOptions(config),
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are read-only there (proxy.ts refreshes them).
        }
      },
    },
  });
}

export function authCookieOptions(config: SupabaseAuthConfig) {
  return { httpOnly: true, sameSite: "lax" as const, secure: config.siteUrl.startsWith("https://"), path: "/" };
}
