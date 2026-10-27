import { LogOut } from "lucide-react";
import { signOutAction } from "@/app/auth/actions";
import { cn } from "@/lib/utils";

/** Plain form post so sign-out works without client JavaScript. */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction}>
      <button type="submit" className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:underline focus-visible:outline-2", className)}>
        <LogOut className="size-3.5" aria-hidden="true" />
        Sign out
      </button>
    </form>
  );
}
