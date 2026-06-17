import type { NextRequest } from "next/server";
import { processTurn, startSession, openingMessage } from "@/lib/orchestrator";
import { store } from "@/lib/db/store";

// Orchestrator entry. Node runtime (Neon driver + AI SDK). Non-streaming: the
// Output Validator inspects the FULL response before it reaches the consumer
// (design §13) — a small, deliberate latency tradeoff on fact-carrying turns.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const { sessionId, message } = await req.json();
  if (!sessionId) {
    return Response.json({ error: "sessionId required" }, { status: 400 });
  }

  const existing = await store.getSession(sessionId);
  if (!existing) {
    await startSession(sessionId);
    return Response.json({ reply: openingMessage(), stage: "CONSENT" });
  }
  if (!message || !message.trim()) {
    return Response.json({ reply: openingMessage(), stage: existing.fsmState });
  }

  try {
    const result = await processTurn(sessionId, message);
    return Response.json(result);
  } catch (e) {
    console.error("processTurn error:", e);
    return Response.json(
      { reply: "Sorry — something went wrong on our end. Please try again.", stage: existing.fsmState },
      { status: 500 },
    );
  }
}
