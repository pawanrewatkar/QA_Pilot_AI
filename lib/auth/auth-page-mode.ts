import "server-only";
import { authProvider, resolveIdentityConfig } from "./identity";
import { getRequestIdentity } from "./request-identity";

/** What an auth page should render: the form, or a notice that sign-in is not used / not configured. */
export async function authPageMode(): Promise<{ kind: "local" } | { kind: "unconfigured" } | { kind: "signedIn" } | { kind: "form" }> {
  if (authProvider() !== "supabase") return { kind: "local" };
  const cfg = resolveIdentityConfig();
  if (!cfg.ok) return { kind: "unconfigured" };
  return (await getRequestIdentity()).ok ? { kind: "signedIn" } : { kind: "form" };
}
