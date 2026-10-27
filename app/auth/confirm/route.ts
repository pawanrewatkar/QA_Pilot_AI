import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { identityFromVerifiedUser, resolveIdentityConfig } from "@/lib/auth/identity";
import { safeNextPath } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

/**
 * Landing point for links in Supabase emails (confirmation, password reset, invite, email change).
 *
 * Supported inputs: `token_hash` + `type` (verifyOtp) or `code` (PKCE exchange). Inputs are validated before
 * anything is sent to Supabase. A redirect here is never proof of authentication: after the exchange the user
 * is re-read from the Auth server and must be confirmed and allow-listed. Redirects only go to same-origin
 * paths on the configured site URL, and never carry tokens.
 */
const OTP_TYPES = new Set<EmailOtpType>(["signup", "email", "recovery", "invite", "email_change"]);
const TOKEN = /^[A-Za-z0-9_-]{6,512}$/;

export async function GET(request: Request) {
  const cfg = resolveIdentityConfig();
  if (!cfg.ok || cfg.mode !== "supabase") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const site = cfg.config.siteUrl;
  const fail = (code: string) => NextResponse.redirect(new URL(`/login?error=${code}`, site), 303);

  const params = new URL(request.url).searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const code = params.get("code");
  const supabase = await createSupabaseServerClient(cfg.config);

  let recovery = false;
  if (tokenHash !== null || type !== null) {
    if (!tokenHash || !TOKEN.test(tokenHash) || !type || !OTP_TYPES.has(type as EmailOtpType)) return fail("invalid_link");
    const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
    if (error) return fail("link_expired");
    recovery = type === "recovery";
  } else if (code !== null) {
    if (!TOKEN.test(code)) return fail("invalid_link");
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return fail("link_expired");
  } else {
    return fail("invalid_link");
  }

  // Validate the resulting session on the server; only confirmed, allow-listed users may continue.
  const { data } = await supabase.auth.getUser();
  if (!identityFromVerifiedUser(data?.user).ok) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    return fail("not_permitted");
  }
  const next = recovery ? "/auth/update-password" : safeNextPath(params.get("next"));
  return NextResponse.redirect(new URL(next, site), 303);
}
