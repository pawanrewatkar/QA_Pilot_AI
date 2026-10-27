import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authProvider, resolveIdentityConfig } from "@/lib/auth/identity";

/**
 * Next.js 16 Proxy (formerly Middleware).
 *
 * Local mode (AUTH_PROVIDER=local, the default): does nothing.
 * Supabase mode: refreshes the session cookies on every request (the supported @supabase/ssr pattern) and
 * redirects signed-out browsers on protected pages to /login. This redirect is only an optimistic check;
 * authorization is enforced next to the data (lib/server/db.ts → verified, confirmed, allow-listed user →
 * owner-scoped provider). API routes are not redirected: they answer 401 themselves.
 */

/** Pages reachable without a session. */
const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/auth/confirm", "/auth-required", "/copyright"];
const isPublic = (path: string) => PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

export async function proxy(request: NextRequest) {
  if (authProvider() !== "supabase") return NextResponse.next();
  const cfg = resolveIdentityConfig();
  // Misconfigured Supabase mode: let pages render /auth-required (data access stays closed).
  if (!cfg.ok || cfg.mode !== "supabase") return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(cfg.config.url, cfg.config.publishableKey, {
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: cfg.config.siteUrl.startsWith("https://"), path: "/" },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        // Responses that set auth cookies must not be cached by a CDN or shared proxy.
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  // Validates (and if needed refreshes) the session with the Auth server.
  const { data } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
  const path = request.nextUrl.pathname;
  if (!data.user && !isPublic(path) && !path.startsWith("/api/")) {
    const login = new URL("/login", cfg.config.siteUrl);
    login.searchParams.set("next", `${path}${request.nextUrl.search}`);
    const redirect = NextResponse.redirect(login, 307);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    for (const key of ["cache-control", "expires", "pragma"]) {
      const value = response.headers.get(key);
      if (value) redirect.headers.set(key, value);
    }
    return redirect;
  }
  return response;
}

export const config = {
  // Everything except static assets and image files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
