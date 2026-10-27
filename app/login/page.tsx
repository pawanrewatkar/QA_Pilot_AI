import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { signInAction } from "@/app/auth/actions";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthCard, AuthUnavailable } from "@/components/auth/auth-page";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { authPageMode } from "@/lib/auth/auth-page-mode";
import { safeNextPath } from "@/lib/auth/redirect";

export const metadata: Metadata = { title: "Sign in" };

/** Messages for the codes the confirmation route and sign-out may add. Unknown codes are ignored. */
const NOTICES: Record<string, { tone: "destructive" | "success" | "info"; text: string }> = {
  invalid_link: { tone: "destructive", text: "That link is not valid. Request a new one." },
  link_expired: { tone: "destructive", text: "That link has expired or was already used. Request a new one." },
  not_permitted: { tone: "destructive", text: "This account cannot sign in to this instance." },
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNextPath(one(sp.next));
  const mode = await authPageMode();
  if (mode.kind === "signedIn") redirect(next);
  if (mode.kind !== "form") return <AuthUnavailable local={mode.kind === "local"} />;
  const notice = NOTICES[one(sp.error) ?? ""] ?? (one(sp.signedOut) ? { tone: "success" as const, text: "You have been signed out." } : null);

  return (
    <AuthCard
      title="Sign in"
      description="Use the email address and password of your QA Pilot AI account."
      footer={
        <>
          <Link href="/forgot-password" className="underline underline-offset-2">Forgot your password?</Link>
          <span>
            No account yet? <Link href="/signup" className="underline underline-offset-2">Register</Link>
          </span>
        </>
      }
    >
      {notice ? (
        <Alert variant={notice.tone}>
          <AlertTitle>{notice.text}</AlertTitle>
        </Alert>
      ) : null}
      <AuthForm action={signInAction} fields={["email", "password"]} submitLabel="Sign in" pendingLabel="Signing in…" next={next} />
    </AuthCard>
  );
}
