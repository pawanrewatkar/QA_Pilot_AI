"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { isEmailAllowed, normalizeEmail, parseAllowList } from "@/lib/auth/allow-list";
import { authProvider, identityFromVerifiedUser, resolveIdentityConfig } from "@/lib/auth/identity";
import { GENERIC } from "@/lib/auth/messages";
import { safeNextPath } from "@/lib/auth/redirect";
import type { SupabaseAuthConfig } from "@/lib/auth/supabase-config";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

/**
 * Email/password authentication through Supabase Auth. Passwords are handled only by Supabase; nothing here
 * stores or logs passwords, tokens or the allow-list. Responses never reveal whether an account exists or
 * whether an address is on the allow-list.
 */

export interface AuthFormState {
  status: "idle" | "error" | "success";
  message: string;
  fieldErrors?: Partial<Record<"email" | "password" | "confirmPassword", string>>;
}

const emailField = z.string().trim().min(1, "Enter your email address.").max(254, "Email address is too long.");
// Supabase (bcrypt) uses at most 72 bytes; a minimum of 8 characters is enforced here and should match the dashboard setting.
const passwordField = z.string().min(8, "Use at least 8 characters.").max(72, "Use at most 72 characters.");

function fieldErrors(error: z.ZodError): AuthFormState["fieldErrors"] {
  const out: NonNullable<AuthFormState["fieldErrors"]> = {};
  for (const issue of error.issues) {
    const key = issue.path[0] as keyof NonNullable<AuthFormState["fieldErrors"]>;
    out[key] ??= issue.message;
  }
  return out;
}

/** Supabase configuration, or null when this instance is not in (correctly configured) Supabase mode. */
function supabaseConfig(): SupabaseAuthConfig | null {
  if (authProvider() !== "supabase") return null;
  const cfg = resolveIdentityConfig();
  return cfg.ok && cfg.mode === "supabase" ? cfg.config : null;
}

const isWeakPassword = (error: { code?: string } | null | undefined) => error?.code === "weak_password";
const isRateLimited = (error: { code?: string; status?: number } | null | undefined) => error?.status === 429 || /rate_limit/.test(error?.code ?? "");

export async function signUpAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const config = supabaseConfig();
  if (!config) return { status: "error", message: GENERIC.unavailable };
  const parsed = z
    .object({ email: emailField, password: passwordField, confirmPassword: z.string() })
    .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: "The passwords do not match." })
    .safeParse({ email: formData.get("email"), password: formData.get("password"), confirmPassword: formData.get("confirmPassword") });
  if (!parsed.success) return { status: "error", message: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  const email = normalizeEmail(parsed.data.email);
  if (!email) return { status: "error", message: "Check the highlighted fields.", fieldErrors: { email: "Enter a valid email address." } };

  // Server-side allow-list. A missing or empty list closes registration (fail closed).
  const allowList = parseAllowList(process.env.AUTH_ALLOWED_EMAILS);
  if (allowList.emails.size === 0 && allowList.domains.size === 0) return { status: "error", message: GENERIC.registrationClosed };
  // Not allowed: answer exactly as for an allowed address, without contacting Supabase.
  if (!isEmailAllowed(email, allowList)) return { status: "success", message: GENERIC.signUp };

  const supabase = await createSupabaseServerClient(config);
  const { error } = await supabase.auth.signUp({ email, password: parsed.data.password, options: { emailRedirectTo: `${config.siteUrl}/auth/confirm?next=/` } });
  if (isWeakPassword(error)) return { status: "error", message: "Choose a stronger password.", fieldErrors: { password: "This password does not meet the password policy." } };
  if (isRateLimited(error)) return { status: "error", message: GENERIC.tryLater };
  // Other errors (including "already registered") get the generic answer, so accounts cannot be enumerated.
  return { status: "success", message: GENERIC.signUp };
}

export async function signInAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const config = supabaseConfig();
  if (!config) return { status: "error", message: GENERIC.unavailable };
  const parsed = z.object({ email: emailField, password: z.string().min(1, "Enter your password.").max(72) }).safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { status: "error", message: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  const email = normalizeEmail(parsed.data.email);
  if (!email) return { status: "error", message: GENERIC.signIn };

  const supabase = await createSupabaseServerClient(config);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: parsed.data.password });
  if (isRateLimited(error)) return { status: "error", message: GENERIC.tryLater };
  if (error || !data?.user) return { status: "error", message: GENERIC.signIn };
  // A valid password is not enough: the account must be confirmed and on the allow-list right now.
  const identity = identityFromVerifiedUser(data.user);
  if (!identity.ok) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    return { status: "error", message: GENERIC.signIn };
  }
  redirect(safeNextPath(formData.get("next")));
}

export async function signOutAction(): Promise<void> {
  const config = supabaseConfig();
  if (config) {
    const supabase = await createSupabaseServerClient(config);
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    redirect("/login?signedOut=1");
  }
  redirect("/");
}

export async function requestPasswordResetAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const config = supabaseConfig();
  if (!config) return { status: "error", message: GENERIC.unavailable };
  const parsed = z.object({ email: emailField }).safeParse({ email: formData.get("email") });
  if (!parsed.success) return { status: "error", message: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  const email = normalizeEmail(parsed.data.email);
  // Reset emails are only sent to allow-listed addresses; the answer is identical either way.
  if (email && isEmailAllowed(email, parseAllowList(process.env.AUTH_ALLOWED_EMAILS))) {
    const supabase = await createSupabaseServerClient(config);
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${config.siteUrl}/auth/confirm?next=/auth/update-password` });
    if (isRateLimited(error)) return { status: "error", message: GENERIC.tryLater };
  }
  return { status: "success", message: GENERIC.reset };
}

/** Completes a reset (or changes the password of the signed-in, permitted user). Requires a verified session. */
export async function updatePasswordAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const config = supabaseConfig();
  if (!config) return { status: "error", message: GENERIC.unavailable };
  const parsed = z
    .object({ password: passwordField, confirmPassword: z.string() })
    .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: "The passwords do not match." })
    .safeParse({ password: formData.get("password"), confirmPassword: formData.get("confirmPassword") });
  if (!parsed.success) return { status: "error", message: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createSupabaseServerClient(config);
  const { data } = await supabase.auth.getUser();
  if (!identityFromVerifiedUser(data?.user).ok) return { status: "error", message: "This reset link has expired or is not valid. Request a new one." };
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (isWeakPassword(error)) return { status: "error", message: "Choose a stronger password.", fieldErrors: { password: "This password does not meet the password policy." } };
  if (error) return { status: "error", message: GENERIC.tryLater };
  redirect("/?passwordUpdated=1");
}
