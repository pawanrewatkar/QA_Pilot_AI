import { LockKeyhole } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { IDENTITY_FAILURE_MESSAGES, resolveIdentity } from "@/lib/auth/identity";

export const metadata: Metadata = { title: "Sign-in required" };

/**
 * Public page shown instead of any protected page when no trusted identity is available. It reads no
 * project data. Sign-in (Supabase Auth) is a later step; until then a hosted deployment stays closed.
 */
export default async function AuthRequiredPage() {
  await connection();
  const result = resolveIdentity();
  const reason = result.ok ? null : IDENTITY_FAILURE_MESSAGES[result.reason];

  return (
    <div className="space-y-6">
      <PageHeader title="Sign-in required" description="QA Pilot AI only shows projects, results, bugs and reports to their owner." />
      <EmptyState
        icon={LockKeyhole}
        title={result.ok ? "You are signed in" : "No signed-in identity"}
        description={
          result.ok ? (
            "This instance is running in local single-user mode. Use the navigation to continue."
          ) : (
            <>
              <p>{reason}</p>
              <p className="mt-2">
                For local development run <span className="font-mono">npm run dev:all</span>. For a local production build start it with{" "}
                <span className="font-mono">QA_PILOT_LOCAL_MODE=true</span>.
              </p>
            </>
          )
        }
      />
    </div>
  );
}
