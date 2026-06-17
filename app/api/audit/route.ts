import type { NextRequest } from "next/server";
import { store } from "@/lib/db/store";

// Read-only view of the compliance evidence chain for a session (design §14).
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "sessionId required" }, { status: 400 });
  }
  const events = await store.getAudit(sessionId);
  return Response.json({ events });
}
