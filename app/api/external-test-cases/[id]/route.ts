import { getDatabase } from "@/lib/database";

/** Polled by the live progress panel of an external test-case execution. */
export async function GET(_request: Request, ctx: RouteContext<"/api/external-test-cases/[id]">) {
  const { id } = await ctx.params;
  const execution = await getDatabase().externalTests.get(id);
  if (!execution) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(execution, { headers: { "Cache-Control": "no-store" } });
}
