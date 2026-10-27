import { LockKeyhole } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { authProvider, IDENTITY_FAILURE_MESSAGES } from "@/lib/auth/identity";
import { getRequestIdentity } from "@/lib/auth/request-identity";

export const metadata: Metadata = { title: "Sign-in required" };

/**
 * Public page shown instead of a protected page when no trusted identity is available. It reads no
 * project data and never shows configuration values (such as the email allow-list).
 */
export default async function AuthRequiredPage() {
  await connection();
  const result = await getRequestIdentity();
  const supabase = authProvider() === "supabase";

  return (
    <div className="space-y-6">
      <PageHeader title="Sign-in required" description="QA Pilot AI only shows projects, results, bugs and reports to their owner." />
      <EmptyState
        icon={LockKeyhole}
        title={result.ok ? "You are signed in" : "No signed-in identity"}
        description={
          result.ok ? (
            "Use the navigation to continue."
          ) : (
            <>
              <p>{IDENTITY_FAILURE_MESSAGES[result.reason]}</p>
              {supabase ? null : (
                <p className="mt-2">
                  For local development run <span className="font-mono">npm run dev:all</span>. For a local production build start it with{" "}
                  <span className="font-mono">QA_PILOT_LOCAL_MODE=true</span>.
                </p>
              )}
            </>
          )
        }
        action={
          supabase && !result.ok && result.reason !== "SUPABASE_NOT_CONFIGURED" ? (
            <Button asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
