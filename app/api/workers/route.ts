import { connection } from "next/server";
import { routeDb } from "@/lib/server/db";

export async function GET() {
  await connection();
  const access = routeDb();
  if (access.denied) return access.denied;
  return Response.json(await access.db.workers.status(), { headers: { "Cache-Control": "no-store" } });
}
