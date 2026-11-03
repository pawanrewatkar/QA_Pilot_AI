import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { GENERIC } from "@/lib/auth/messages";
import { LOCAL_PATH_UNAVAILABLE } from "@/lib/external-tests/sources";
import { makeTempDir } from "./helpers";

/**
 * Supabase Auth integration, fully mocked: @supabase/ssr and next/headers are replaced, so no network call
 * is made and no real Supabase project is contacted. All keys, URLs and users below are fake placeholders.
 */

const state = vi.hoisted(() => ({
  /** Options passed to the most recent createServerClient call (cookie adapter, cookie options). */
  options: null as null | { cookieOptions?: Record<string, unknown>; cookies: { getAll: () => unknown; setAll: (c: unknown[], h?: Record<string, string>) => void } },
  createCalls: 0,
  auth: {} as Record<string, ReturnType<typeof vi.fn>>,
  cookieJar: new Map<string, string>(),
  cookieSetCalls: [] as { name: string; value: string; options?: Record<string, unknown> }[],
  cookiesReadOnly: false,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: NonNullable<typeof state.options>) => {
    state.options = options;
    state.createCalls++;
    return { auth: state.auth };
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...state.cookieJar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (state.cookiesReadOnly) throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      state.cookieSetCalls.push({ name, value, options });
      state.cookieJar.set(name, value);
    },
  }),
}));

const SITE = "https://qa.example.test";
const SUPABASE_ENV = {
  AUTH_PROVIDER: "supabase",
  NEXT_PUBLIC_SUPABASE_URL: "https://example-ref.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder_000000000000",
  NEXT_PUBLIC_SITE_URL: SITE,
  AUTH_ALLOWED_EMAILS: "alice@example.com,@team.example",
};
const ALICE = { id: "0f8fad5b-d9cb-469f-a165-70867728950e", email: "Alice@Example.com", email_confirmed_at: "2026-10-01T00:00:00Z" };
const MALLORY = { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", email: "mallory@elsewhere.test", email_confirmed_at: "2026-10-01T00:00:00Z" };

const ENV_KEYS = [...Object.keys(SUPABASE_ENV), "NEXT_PUBLIC_SUPABASE_ANON_KEY", "QA_PILOT_LOCAL_MODE", "VERCEL"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// Any code path that opens the database must use a throwaway file, never ./data/qa-pilot.db.
const tempDir = makeTempDir();
process.env.DATABASE_PATH = path.join(tempDir, "auth.db");
process.env.STORAGE_PATH = path.join(tempDir, "storage");
// Shared "local file path" folder holding a valid workbook, so a successful read would be visible.
const sharedDir = path.join(tempDir, "test-cases");
process.env.EXTERNAL_TEST_CASES_DIR = sharedDir;

function useEnv(values: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
}

function resetAuth() {
  const ok = (data: unknown = {}) => vi.fn(async () => ({ data, error: null }));
  state.auth = {
    getUser: vi.fn(async () => ({ data: { user: null }, error: { message: "Auth session missing!", status: 400 } })),
    signUp: ok({ user: null, session: null }),
    signInWithPassword: ok({ user: ALICE, session: {} }),
    signOut: vi.fn(async () => ({ error: null })),
    resetPasswordForEmail: ok(),
    updateUser: ok({ user: ALICE }),
    verifyOtp: ok({ user: ALICE, session: {} }),
    exchangeCodeForSession: ok({ user: ALICE, session: {} }),
  };
}

const signedInAs = (user: unknown) => state.auth.getUser.mockImplementation(async () => ({ data: { user }, error: null }));

const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};

/** Target path of a Next.js redirect() thrown by a server action, or null if it did not redirect. */
async function redirectTarget(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw err;
    return digest.split(";")[2] ?? null;
  }
}

const idle = { status: "idle" as const, message: "" };

beforeEach(() => {
  useEnv(SUPABASE_ENV);
  resetAuth();
  state.options = null;
  state.createCalls = 0;
  state.cookieJar.clear();
  state.cookieSetCalls = [];
  state.cookiesReadOnly = false;
});
afterEach(() => useEnv(savedEnv));

describe("configuration", () => {
  it("keeps local mode as the default and never contacts Supabase there", async () => {
    useEnv({});
    const { authProvider, resolveIdentityConfig } = await import("@/lib/auth/identity");
    const { getRequestIdentity } = await import("@/lib/auth/request-identity");
    expect(authProvider()).toBe("local");
    expect(resolveIdentityConfig()).toMatchObject({ ok: true, mode: "local" });
    expect(await getRequestIdentity()).toMatchObject({ ok: true, identity: { source: "local" } });
    expect(state.createCalls).toBe(0);
  });

  it("requires a complete, valid Supabase configuration and never falls back to local", async () => {
    const { readSupabaseAuthConfig } = await import("@/lib/auth/supabase-config");
    const { resolveIdentityConfig } = await import("@/lib/auth/identity");
    expect(readSupabaseAuthConfig(SUPABASE_ENV)).toEqual({
      ok: true,
      config: { url: SUPABASE_ENV.NEXT_PUBLIC_SUPABASE_URL, publishableKey: SUPABASE_ENV.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, siteUrl: SITE },
    });
    const bad: Record<string, string | undefined>[] = [
      { NEXT_PUBLIC_SUPABASE_URL: undefined },
      { NEXT_PUBLIC_SUPABASE_URL: "http://example-ref.supabase.co" }, // plain http outside loopback
      { NEXT_PUBLIC_SUPABASE_URL: "https://user:pw@example-ref.supabase.co" },
      { NEXT_PUBLIC_SITE_URL: undefined },
      { NEXT_PUBLIC_SITE_URL: "https://qa.example.test/app" }, // must be an origin
      { NEXT_PUBLIC_SITE_URL: "javascript:alert(1)" },
      { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined },
      { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_placeholder_000000000000000" }, // secret keys are refused
      { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "short" },
    ];
    for (const override of bad) {
      expect(readSupabaseAuthConfig({ ...SUPABASE_ENV, ...override }).ok, JSON.stringify(override)).toBe(false);
      expect(resolveIdentityConfig({ ...SUPABASE_ENV, ...override }), JSON.stringify(override)).toEqual({ ok: false, reason: "SUPABASE_NOT_CONFIGURED" });
    }
    // Loopback http is fine for local development against a local Supabase stack.
    expect(readSupabaseAuthConfig({ ...SUPABASE_ENV, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }).ok).toBe(true);
    // The legacy anon key is accepted when no publishable key is set.
    expect(readSupabaseAuthConfig({ ...SUPABASE_ENV, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiJ9.placeholder" }).ok).toBe(true);
  });

  it("misconfigured Supabase mode denies access without calling Supabase", async () => {
    useEnv({ ...SUPABASE_ENV, NEXT_PUBLIC_SUPABASE_URL: undefined });
    const { getRequestIdentity } = await import("@/lib/auth/request-identity");
    expect(await getRequestIdentity()).toEqual({ ok: false, reason: "SUPABASE_NOT_CONFIGURED" });
    expect(state.createCalls).toBe(0);
  });
});

describe("verified identity", () => {
  it("accepts only confirmed, allow-listed users with a UUID id, and normalizes the email", async () => {
    const { identityFromVerifiedUser } = await import("@/lib/auth/identity");
    expect(identityFromVerifiedUser(ALICE)).toEqual({ ok: true, identity: { ownerId: ALICE.id, source: "supabase", email: "alice@example.com" } });
    expect(identityFromVerifiedUser({ ...ALICE, id: ALICE.id.toUpperCase() })).toMatchObject({ ok: true, identity: { ownerId: ALICE.id } });
    expect(identityFromVerifiedUser({ ...MALLORY, email: "Bob@Team.Example" })).toMatchObject({ ok: true }); // domain entry
    expect(identityFromVerifiedUser(null)).toEqual({ ok: false, reason: "UNAUTHENTICATED" });
    expect(identityFromVerifiedUser({ ...ALICE, email_confirmed_at: null })).toEqual({ ok: false, reason: "EMAIL_NOT_CONFIRMED" });
    expect(identityFromVerifiedUser({ ...ALICE, email_confirmed_at: "not a date" })).toEqual({ ok: false, reason: "EMAIL_NOT_CONFIRMED" });
    expect(identityFromVerifiedUser(MALLORY)).toEqual({ ok: false, reason: "NOT_ALLOWED" });
    expect(identityFromVerifiedUser({ ...ALICE, id: "local:default" })).toEqual({ ok: false, reason: "INVALID_USER" });
    expect(identityFromVerifiedUser({ ...ALICE, id: "user-1" })).toEqual({ ok: false, reason: "INVALID_USER" });
    expect(identityFromVerifiedUser({ ...ALICE, email: "not-an-email" })).toEqual({ ok: false, reason: "INVALID_USER" });
  });

  it("fails closed when the allow-list is missing, empty or malformed", async () => {
    const { identityFromVerifiedUser } = await import("@/lib/auth/identity");
    for (const list of [undefined, "", " , ", "not-an-email", "@", "alice@example.com;bob@example.com"]) {
      expect(identityFromVerifiedUser(ALICE, { ...SUPABASE_ENV, AUTH_ALLOWED_EMAILS: list }), String(list)).toEqual({ ok: false, reason: "NOT_ALLOWED" });
    }
  });

  it("removal from the allow-list takes effect on the next request", async () => {
    const { getRequestIdentity } = await import("@/lib/auth/request-identity");
    signedInAs(ALICE);
    expect(await getRequestIdentity()).toMatchObject({ ok: true });
    process.env.AUTH_ALLOWED_EMAILS = "someone@example.com";
    expect(await getRequestIdentity()).toEqual({ ok: false, reason: "NOT_ALLOWED" });
  });

  it("derives the owner only from the Auth server, never from client-supplied values", async () => {
    const { getRequestIdentity } = await import("@/lib/auth/request-identity");
    state.cookieJar.set("owner_id", MALLORY.id);
    state.cookieJar.set("x-user-id", MALLORY.id);
    signedInAs(ALICE);
    expect(await getRequestIdentity()).toEqual({ ok: true, identity: { ownerId: ALICE.id, source: "supabase", email: "alice@example.com" } });
    expect(state.auth.getUser).toHaveBeenCalledTimes(1); // validated with the Auth server, not decoded locally
  });

  it("gives unauthenticated or failing requests no identity", async () => {
    const { getRequestIdentity } = await import("@/lib/auth/request-identity");
    expect(await getRequestIdentity()).toEqual({ ok: false, reason: "UNAUTHENTICATED" });
    state.auth.getUser.mockImplementation(async () => {
      throw new Error("network down");
    });
    expect(await getRequestIdentity()).toEqual({ ok: false, reason: "UNAUTHENTICATED" });
  });

  it("data helpers deny unauthenticated requests and send pages to /login", async () => {
    const { actionDb, routeDb } = await import("@/lib/server/db");
    expect((await routeDb()).denied?.status).toBe(401);
    expect(await redirectTarget(() => actionDb())).toBe("/login");
    signedInAs(ALICE);
    const access = await routeDb();
    if (access.denied) throw new Error("expected access");
    expect(access.identity.ownerId).toBe(ALICE.id);
  });
});

describe("session cookies", () => {
  it("uses httpOnly, sameSite=lax, secure cookies and writes refreshed tokens to the cookie store", async () => {
    const { createSupabaseServerClient } = await import("@/lib/auth/supabase-server");
    const { readSupabaseAuthConfig } = await import("@/lib/auth/supabase-config");
    const cfg = readSupabaseAuthConfig(SUPABASE_ENV);
    if (!cfg.ok) throw new Error("config");
    state.cookieJar.set("sb-example-ref-auth-token", "old");
    await createSupabaseServerClient(cfg.config);
    expect(state.options?.cookieOptions).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(state.options?.cookies.getAll()).toEqual([{ name: "sb-example-ref-auth-token", value: "old" }]);
    state.options?.cookies.setAll([{ name: "sb-example-ref-auth-token", value: "new", options: { httpOnly: true } }]);
    expect(state.cookieJar.get("sb-example-ref-auth-token")).toBe("new");
  });

  it("is not secure on a plain-http local site and ignores writes from read-only contexts", async () => {
    const { createSupabaseServerClient } = await import("@/lib/auth/supabase-server");
    await createSupabaseServerClient({ url: "http://127.0.0.1:54321", publishableKey: "sb_publishable_placeholder_000", siteUrl: "http://localhost:3000" });
    expect(state.options?.cookieOptions).toMatchObject({ secure: false, httpOnly: true });
    state.cookiesReadOnly = true;
    expect(() => state.options?.cookies.setAll([{ name: "a", value: "b", options: {} }])).not.toThrow();
  });
});

describe("sign-up", () => {
  const fields = { email: " Alice@Example.COM ", password: "correct-horse-1", confirmPassword: "correct-horse-1" };

  it("registers an allow-listed address with a normalized email and the configured confirmation link", async () => {
    const { signUpAction } = await import("@/app/auth/actions");
    expect(await signUpAction(idle, form(fields))).toEqual({ status: "success", message: GENERIC.signUp });
    expect(state.auth.signUp).toHaveBeenCalledWith({ email: "alice@example.com", password: "correct-horse-1", options: { emailRedirectTo: `${SITE}/auth/confirm?next=/` } });
  });

  it("answers identically for addresses outside the allow-list without contacting Supabase", async () => {
    const { signUpAction } = await import("@/app/auth/actions");
    expect(await signUpAction(idle, form({ ...fields, email: "mallory@elsewhere.test" }))).toEqual({ status: "success", message: GENERIC.signUp });
    expect(state.createCalls).toBe(0);
    expect(state.auth.signUp).not.toHaveBeenCalled();
  });

  it("closes registration when the allow-list is empty, without revealing its contents", async () => {
    const { signUpAction } = await import("@/app/auth/actions");
    process.env.AUTH_ALLOWED_EMAILS = "";
    const result = await signUpAction(idle, form(fields));
    expect(result).toEqual({ status: "error", message: GENERIC.registrationClosed });
    expect(state.auth.signUp).not.toHaveBeenCalled();
    process.env.AUTH_ALLOWED_EMAILS = SUPABASE_ENV.AUTH_ALLOWED_EMAILS;
    expect(JSON.stringify(await signUpAction(idle, form({ ...fields, email: "x@y.test" })))).not.toContain("alice@example.com");
  });

  it("validates input and maps weak-password and rate-limit errors", async () => {
    const { signUpAction } = await import("@/app/auth/actions");
    expect(await signUpAction(idle, form({ ...fields, confirmPassword: "different-1" }))).toMatchObject({ status: "error", fieldErrors: { confirmPassword: expect.any(String) } });
    expect(await signUpAction(idle, form({ ...fields, password: "short", confirmPassword: "short" }))).toMatchObject({ status: "error", fieldErrors: { password: expect.any(String) } });
    expect(await signUpAction(idle, form({ ...fields, email: "not-an-email" }))).toMatchObject({ status: "error", fieldErrors: { email: expect.any(String) } });
    state.auth.signUp.mockResolvedValueOnce({ data: {}, error: { code: "weak_password", status: 422 } });
    expect(await signUpAction(idle, form(fields))).toMatchObject({ status: "error", fieldErrors: { password: expect.any(String) } });
    state.auth.signUp.mockResolvedValueOnce({ data: {}, error: { code: "over_email_send_rate_limit", status: 429 } });
    expect(await signUpAction(idle, form(fields))).toEqual({ status: "error", message: GENERIC.tryLater });
    // "Already registered" is not revealed.
    state.auth.signUp.mockResolvedValueOnce({ data: {}, error: { code: "user_already_exists", status: 422 } });
    expect(await signUpAction(idle, form(fields))).toEqual({ status: "success", message: GENERIC.signUp });
  });

  it("is unavailable in local mode", async () => {
    useEnv({});
    const { signUpAction } = await import("@/app/auth/actions");
    expect(await signUpAction(idle, form(fields))).toEqual({ status: "error", message: GENERIC.unavailable });
    expect(state.createCalls).toBe(0);
  });
});

describe("sign-in and sign-out", () => {
  it("signs in a permitted user and redirects only to a safe path", async () => {
    const { signInAction } = await import("@/app/auth/actions");
    expect(await redirectTarget(() => signInAction(idle, form({ email: "alice@example.com", password: "pw-123456", next: "/projects?tab=1" })))).toBe("/projects?tab=1");
    expect(state.auth.signInWithPassword).toHaveBeenCalledWith({ email: "alice@example.com", password: "pw-123456" });
    for (const next of ["https://evil.test/", "//evil.test", "/\\evil.test", "/auth/confirm?token_hash=x"]) {
      expect(await redirectTarget(() => signInAction(idle, form({ email: "alice@example.com", password: "pw-123456", next })))).toBe("/");
    }
  });

  it("returns one generic message for wrong credentials", async () => {
    const { signInAction } = await import("@/app/auth/actions");
    state.auth.signInWithPassword.mockResolvedValueOnce({ data: { user: null, session: null }, error: { code: "invalid_credentials", status: 400 } });
    expect(await signInAction(idle, form({ email: "alice@example.com", password: "wrong-pass" }))).toEqual({ status: "error", message: GENERIC.signIn });
  });

  it("signs out again and refuses users who are unconfirmed or not allow-listed", async () => {
    const { signInAction } = await import("@/app/auth/actions");
    for (const user of [MALLORY, { ...ALICE, email_confirmed_at: null }]) {
      state.auth.signOut.mockClear();
      state.auth.signInWithPassword.mockResolvedValueOnce({ data: { user, session: {} }, error: null });
      expect(await signInAction(idle, form({ email: user.email, password: "pw-123456" }))).toEqual({ status: "error", message: GENERIC.signIn });
      expect(state.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    }
  });

  it("signs out and returns to the login page", async () => {
    const { signOutAction } = await import("@/app/auth/actions");
    expect(await redirectTarget(() => signOutAction())).toBe("/login?signedOut=1");
    expect(state.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    useEnv({});
    expect(await redirectTarget(() => signOutAction())).toBe("/");
  });
});

describe("password reset", () => {
  it("sends reset emails only to allow-listed addresses, with the same answer for everyone", async () => {
    const { requestPasswordResetAction } = await import("@/app/auth/actions");
    expect(await requestPasswordResetAction(idle, form({ email: "ALICE@example.com" }))).toEqual({ status: "success", message: GENERIC.reset });
    expect(state.auth.resetPasswordForEmail).toHaveBeenCalledWith("alice@example.com", { redirectTo: `${SITE}/auth/confirm?next=/auth/update-password` });
    state.auth.resetPasswordForEmail.mockClear();
    expect(await requestPasswordResetAction(idle, form({ email: "mallory@elsewhere.test" }))).toEqual({ status: "success", message: GENERIC.reset });
    expect(state.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("updates the password only with a verified, permitted session", async () => {
    const { updatePasswordAction } = await import("@/app/auth/actions");
    const fields = form({ password: "new-password-1", confirmPassword: "new-password-1" });
    expect(await updatePasswordAction(idle, fields)).toMatchObject({ status: "error", message: expect.stringContaining("expired") });
    expect(state.auth.updateUser).not.toHaveBeenCalled();
    signedInAs(MALLORY);
    expect(await updatePasswordAction(idle, fields)).toMatchObject({ status: "error" });
    expect(state.auth.updateUser).not.toHaveBeenCalled();
    signedInAs(ALICE);
    expect(await redirectTarget(() => updatePasswordAction(idle, fields))).toBe("/?passwordUpdated=1");
    expect(state.auth.updateUser).toHaveBeenCalledWith({ password: "new-password-1" });
    expect(await updatePasswordAction(idle, form({ password: "new-password-1", confirmPassword: "other-password" }))).toMatchObject({ fieldErrors: { confirmPassword: expect.any(String) } });
  });
});

describe("email confirmation callback", () => {
  const confirm = async (query: string) => {
    const { GET } = await import("@/app/auth/confirm/route");
    const res = await GET(new Request(`https://attacker-host.test/auth/confirm?${query}`));
    return { status: res.status, location: res.headers.get("location") };
  };

  it("verifies a token hash, re-checks the user and redirects on the configured site", async () => {
    signedInAs(ALICE);
    expect(await confirm("token_hash=abcdef123456&type=signup&next=/projects")).toEqual({ status: 303, location: `${SITE}/projects` });
    expect(state.auth.verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "abcdef123456" });
  });

  it("sends recovery links to the update-password page regardless of next", async () => {
    signedInAs(ALICE);
    expect(await confirm("token_hash=abcdef123456&type=recovery&next=/projects")).toEqual({ status: 303, location: `${SITE}/auth/update-password` });
  });

  it("supports the PKCE code exchange", async () => {
    signedInAs(ALICE);
    expect(await confirm("code=0123456789abcdef")).toEqual({ status: 303, location: `${SITE}/` });
    expect(state.auth.exchangeCodeForSession).toHaveBeenCalledWith("0123456789abcdef");
  });

  it("rejects malformed links before contacting Supabase", async () => {
    for (const q of ["", "type=signup", "token_hash=abcdef123456", "token_hash=abcdef123456&type=magic", "token_hash=a%20b%3Cscript%3E&type=signup", "code=%3Cx%3E"]) {
      expect(await confirm(q), q).toEqual({ status: 303, location: `${SITE}/login?error=invalid_link` });
    }
    expect(state.auth.verifyOtp).not.toHaveBeenCalled();
    expect(state.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("reports expired links and refuses users who are not permitted", async () => {
    state.auth.verifyOtp.mockResolvedValueOnce({ data: {}, error: { code: "otp_expired", status: 403 } });
    expect(await confirm("token_hash=abcdef123456&type=signup")).toEqual({ status: 303, location: `${SITE}/login?error=link_expired` });
    signedInAs(MALLORY);
    expect(await confirm("token_hash=abcdef123456&type=signup")).toEqual({ status: 303, location: `${SITE}/login?error=not_permitted` });
    expect(state.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("never redirects off-site and never echoes tokens", async () => {
    signedInAs(ALICE);
    for (const next of ["https://evil.test", "//evil.test", "/%2F%2Fevil.test", "/auth/confirm?token_hash=again"]) {
      const { location } = await confirm(`token_hash=abcdef123456&type=email&next=${encodeURIComponent(next)}`);
      expect(location, next).toBe(`${SITE}/`);
    }
    expect((await confirm("token_hash=abcdef123456&type=signup")).location).not.toContain("abcdef123456");
  });

  it("does not exist in local mode", async () => {
    useEnv({});
    expect((await confirm("token_hash=abcdef123456&type=signup")).status).toBe(404);
  });
});

describe("safe redirects", () => {
  it("accepts same-origin paths only", async () => {
    const { safeNextPath } = await import("@/lib/auth/redirect");
    expect(safeNextPath("/projects/1?tab=bugs#top")).toBe("/projects/1?tab=bugs#top");
    for (const raw of [undefined, null, 42, "", "projects", "https://evil.test", "//evil.test", "/\\evil.test", "\\\\evil.test", "/%2F%2Fevil.test", "/%5Cevil.test", "javascript:alert(1)", "/a\nb", `/${"a".repeat(600)}`, "/auth/confirm", "/%E0%A4%A"]) {
      expect(safeNextPath(raw), String(raw)).toBe("/");
    }
    expect(safeNextPath("//evil.test", "/login")).toBe("/login");
  });
});

describe("proxy", () => {
  const run = async (url: string) => {
    const { proxy } = await import("@/proxy");
    return proxy(new NextRequest(url, { headers: { cookie: "sb-example-ref-auth-token=old" } }));
  };

  it("does nothing in local mode", async () => {
    useEnv({});
    const res = await run(`${SITE}/projects`);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(state.createCalls).toBe(0);
  });

  it("redirects signed-out page requests to /login with a next path", async () => {
    const res = await run(`${SITE}/projects?tab=1`);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${SITE}/login`);
    expect(location.searchParams.get("next")).toBe("/projects?tab=1");
  });

  it("leaves public pages and API routes alone (APIs answer 401 themselves)", async () => {
    for (const path of ["/login", "/signup", "/forgot-password", "/auth/confirm?code=x", "/auth-required", "/copyright", "/api/test-runs/1"]) {
      expect((await run(`${SITE}${path}`)).headers.get("location"), path).toBeNull();
    }
  });

  it("passes refreshed session cookies and no-cache headers to the response", async () => {
    state.auth.getUser.mockImplementation(async () => {
      expect(state.options?.cookies.getAll()).toEqual([{ name: "sb-example-ref-auth-token", value: "old" }]);
      state.options?.cookies.setAll([{ name: "sb-example-ref-auth-token", value: "refreshed", options: { httpOnly: true, sameSite: "lax", secure: true, path: "/" } }], {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
      });
      return { data: { user: ALICE }, error: null };
    });
    const res = await run(`${SITE}/projects`);
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("sb-example-ref-auth-token")).toMatchObject({ value: "refreshed", httpOnly: true, secure: true, sameSite: "lax" });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(state.options?.cookieOptions).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  });

  it("keeps cleared cookies and no-cache headers on the login redirect", async () => {
    state.auth.getUser.mockImplementation(async () => {
      state.options?.cookies.setAll([{ name: "sb-example-ref-auth-token", value: "", options: { maxAge: 0, path: "/" } }], { "Cache-Control": "private, no-store" });
      return { data: { user: null }, error: { message: "Invalid Refresh Token" } };
    });
    const res = await run(`${SITE}/reports`);
    expect(res.status).toBe(307);
    expect(res.cookies.get("sb-example-ref-auth-token")?.value).toBe("");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("shared server folder for workbooks (EXTERNAL_TEST_CASES_DIR)", () => {
  const draftsDir = path.join(tempDir, "storage", "external-drafts");
  const loadFromFolder = async (relPath: string) => {
    const { loadWorkbookAction } = await import("@/app/external-test-cases/actions");
    const fd = new FormData();
    fd.set("sourceKind", "LOCAL_PATH");
    fd.set("path", relPath);
    return loadWorkbookAction(fd);
  };

  beforeEach(async () => {
    fs.rmSync(draftsDir, { recursive: true, force: true });
    fs.mkdirSync(sharedDir, { recursive: true });
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Cases").addRows([["TC ID", "Scenario", "Steps", "Expected"], ["TC01", "Home", "Open the home page", "Home page loads"]]);
    fs.writeFileSync(path.join(sharedDir, "cases.xlsx"), new Uint8Array(await wb.xlsx.writeBuffer()));
  });

  it("is only available when AUTH_PROVIDER is exactly local", async () => {
    const { sharedWorkbookFolder } = await import("@/lib/external-tests/shared-folder");
    expect(sharedWorkbookFolder({ EXTERNAL_TEST_CASES_DIR: sharedDir })).toBe(sharedDir); // default provider
    expect(sharedWorkbookFolder({ AUTH_PROVIDER: "local", EXTERNAL_TEST_CASES_DIR: sharedDir })).toBe(sharedDir);
    for (const provider of ["supabase", "LOCAL", "none", " supabase "]) {
      expect(sharedWorkbookFolder({ AUTH_PROVIDER: provider, EXTERNAL_TEST_CASES_DIR: sharedDir }), provider).toBeNull();
    }
  });

  it("refuses to read it for a signed-in, permitted Supabase user, without revealing the server path", async () => {
    signedInAs(ALICE);
    for (const p of ["cases.xlsx", "./cases.xlsx", "../test-cases/cases.xlsx", path.join(sharedDir, "cases.xlsx")]) {
      const res = await loadFromFolder(p);
      expect(res, p).toEqual({ ok: false, error: LOCAL_PATH_UNAVAILABLE });
    }
    expect(LOCAL_PATH_UNAVAILABLE).not.toContain(sharedDir);
    expect(fs.existsSync(draftsDir)).toBe(false); // nothing copied into storage
    expect(fs.readdirSync(sharedDir)).toEqual(["cases.xlsx"]); // nothing written to or removed from the folder
  });

  it("redirects signed-out Supabase requests to /login before any file access", async () => {
    expect(await redirectTarget(() => loadFromFolder("cases.xlsx"))).toBe("/login");
    expect(fs.existsSync(draftsDir)).toBe(false);
  });

  it("keeps working in local mode", async () => {
    useEnv({});
    const res = await loadFromFolder("cases.xlsx");
    expect(res).toMatchObject({ ok: true, value: { sourceKind: "LOCAL_PATH", sourceName: "cases.xlsx" } });
    expect(fs.existsSync(draftsDir)).toBe(true);
    // Path traversal is still refused in local mode.
    expect(await loadFromFolder("../auth.db")).toMatchObject({ ok: false });
  });

  it("has no other code path that reads, writes, lists or deletes in the folder", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    for (const d of ["app", "components", "lib", "worker"]) walk(path.resolve(d));
    const rel = (f: string) => path.relative(process.cwd(), f).split(path.sep).join("/");
    const using = (re: RegExp) => files.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map(rel).sort();
    // The folder setting is read in exactly one place: the mode-aware helper.
    expect(using(/\.EXTERNAL_TEST_CASES_DIR\b/)).toEqual(["lib/external-tests/shared-folder.ts"]);
    // The folder reader is constructed in one place, right after the disabled check.
    expect(using(/new LocalPathSourceProvider\(/)).toEqual(["lib/services/external-tests.ts"]);
    expect(fs.readFileSync(path.resolve("lib/services/external-tests.ts"), "utf8")).toMatch(/if \(!deps\.localDir\) throw new SourceError\(LOCAL_PATH_UNAVAILABLE\);\s+return new LocalPathSourceProvider\(deps\.localDir/);
    // The reader only stats and reads; it never writes, lists or deletes.
    const sources = fs.readFileSync(path.resolve("lib/external-tests/sources.ts"), "utf8");
    expect(sources.match(/fs\.\w+\(/g)?.sort()).toEqual(["fs.readFile(", "fs.stat("]);
    // The page and actions take the folder only from the mode-aware helper.
    for (const f of ["app/external-test-cases/page.tsx", "app/external-test-cases/actions.ts"]) {
      const src = fs.readFileSync(path.resolve(f), "utf8");
      expect(src, f).toMatch(/sharedWorkbookFolder\(\)/);
      expect(src, f).not.toMatch(/resolveFromRoot/);
    }
  });
});
