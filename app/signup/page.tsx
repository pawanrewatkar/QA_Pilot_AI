import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { signUpAction } from "@/app/auth/actions";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthCard, AuthUnavailable } from "@/components/auth/auth-page";
import { authPageMode } from "@/lib/auth/auth-page-mode";

export const metadata: Metadata = { title: "Register" };

/** Registration is limited to allow-listed addresses; the check happens in the server action, never here. */
export default async function SignUpPage() {
  await connection();
  const mode = await authPageMode();
  if (mode.kind === "signedIn") redirect("/");
  if (mode.kind !== "form") return <AuthUnavailable local={mode.kind === "local"} />;

  return (
    <AuthCard
      title="Register"
      description="Registration is limited to approved email addresses. You will receive an email to confirm your address before you can sign in."
      footer={
        <span>
          Already registered? <Link href="/login" className="underline underline-offset-2">Sign in</Link>
        </span>
      }
    >
      <AuthForm action={signUpAction} fields={["email", "password", "confirmPassword"]} submitLabel="Register" pendingLabel="Registering…" newPassword />
    </AuthCard>
  );
}
