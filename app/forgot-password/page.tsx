import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requestPasswordResetAction } from "@/app/auth/actions";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthCard, AuthUnavailable } from "@/components/auth/auth-page";
import { authPageMode } from "@/lib/auth/auth-page-mode";

export const metadata: Metadata = { title: "Reset password" };

export default async function ForgotPasswordPage() {
  await connection();
  const mode = await authPageMode();
  if (mode.kind === "local" || mode.kind === "unconfigured") return <AuthUnavailable local={mode.kind === "local"} />;

  return (
    <AuthCard
      title="Reset your password"
      description="Enter your account's email address. If it belongs to a permitted account, you will receive a link to choose a new password."
      footer={<Link href="/login" className="underline underline-offset-2">Back to sign in</Link>}
    >
      <AuthForm action={requestPasswordResetAction} fields={["email"]} submitLabel="Send reset link" pendingLabel="Sending…" />
    </AuthCard>
  );
}
