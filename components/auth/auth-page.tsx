import { Info } from "lucide-react";
import Link from "next/link";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

/** Centered card used by the sign-in, registration and password pages. */
export function AuthCard({ title, description, children, footer }: { title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md py-6">
      <Card>
        <CardHeader>
          <h1 className="text-xl font-semibold leading-tight">{title}</h1>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="grid gap-4">
          {children}
          {footer ? <div className="grid gap-1 text-sm text-muted-foreground">{footer}</div> : null}
        </CardContent>
      </Card>
    </div>
  );
}

/** Shown on the auth pages when the instance runs in local single-user mode or sign-in is not configured. */
export function AuthUnavailable({ local }: { local: boolean }) {
  return (
    <AuthCard title="Sign-in is not used here">
      <Alert>
        <Info />
        <AlertTitle>
          {local ? "This instance runs in local single-user mode (AUTH_PROVIDER=local), so no account is needed." : "Supabase sign-in is selected but not fully configured on the server."}
        </AlertTitle>
      </Alert>
      <Button asChild>
        <Link href={local ? "/" : "/auth-required"}>{local ? "Go to the dashboard" : "Details"}</Link>
      </Button>
    </AuthCard>
  );
}
