import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { updatePasswordAction } from "@/app/auth/actions";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthCard, AuthUnavailable } from "@/components/auth/auth-page";
import { authPageMode } from "@/lib/auth/auth-page-mode";

export const metadata: Metadata = { title: "Choose a new password" };

/**
 * Reached from a password-reset email via /auth/confirm, which has already verified the link and created a
 * session. The server action re-checks the session before changing the password.
 */
export default async function UpdatePasswordPage() {
  await connection();
  const mode = await authPageMode();
  if (mode.kind === "local" || mode.kind === "unconfigured") return <AuthUnavailable local={mode.kind === "local"} />;
  if (mode.kind === "form") {
    return (
      <AuthCard title="Link expired" description="This password-reset link has expired or is no longer valid.">
        <Link href="/forgot-password" className="underline underline-offset-2">Request a new reset link</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <AuthForm action={updatePasswordAction} fields={["password", "confirmPassword"]} submitLabel="Save new password" pendingLabel="Saving…" newPassword />
    </AuthCard>
  );
}
