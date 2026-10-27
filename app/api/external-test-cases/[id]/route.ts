import { routeDb } from "@/lib/server/db";

/** Polled by the live progress panel of an external test-case execution. */
export async function GET(_request: Request, ctx: RouteContext<"/api/external-test-cases/[id]">) {
  const access = routeDb();
  if (access.denied) return access.denied;
  const { id } = await ctx.params;
  const execution = await access.db.externalTests.get(id);
  if (!execution) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(execution, { headers: { "Cache-Control": "no-store" } });
}
