import { connection } from "next/server";
import { getDatabase } from "@/lib/database";

export async function GET() {
  await connection();
  return Response.json(await getDatabase().workers.status(), { headers: { "Cache-Control": "no-store" } });
}
