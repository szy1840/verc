import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { ChatMessage } from "../db/store.ts";
import { CONFIG } from "../config.ts";

// NLU: consumer message → structured {action, slots, confidence} (design §12).
// Produces NO consumer-facing text — it cannot hallucinate to the consumer.

function model() {
  return anthropic(CONFIG.llm.model);
}

const NLUSchema = z.object({
  action: z.string().describe("exactly one action label from the allowed set"),
  slots: z.object({
    amount: z.number().optional().describe("dollar amount as stated"),
    cadence: z.enum(["lump", "monthly"]).optional(),
    months: z.number().int().optional(),
    questionType: z
      .enum(["balance", "payoff", "creditor", "account_status", "other"])
      .optional(),
    authFields: z
      .object({
        accountRef: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        last4ssn: z.string().optional(),
        zip: z.string().optional(),
      })
      .optional(),
    fcFields: z
      .object({
        netMonthlyIncome: z.number().optional(),
        payCadence: z.string().optional(),
        lastPayDate: z.string().optional(),
        housingPayment: z.number().optional(),
        vehiclePayments: z.number().optional(),
        otherObligations: z.number().optional(),
        hasCheckingAccount: z.boolean().optional(),
        callbackNumber: z.string().optional(),
      })
      .optional(),
  }),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

export type NLUResult = z.infer<typeof NLUSchema>;

const SYSTEM = `You are the intent classifier for the web chat assistant of Meridian Recovery Services, a third-party debt-collection agency that helps consumers resolve past-due accounts. You do NOT talk to the consumer. Given the conversation, the current state, the offer on the table (if any), and the allowed action labels, output ONLY a JSON object matching the schema.

Rules:
- Pick exactly one action from the allowed set. Escalation intents and REQUEST_HUMAN are always allowed.
- Extract relevant values into slots (amounts in dollars as stated; ZIP/SSN as digit strings).
- CRITICAL: distinguish DISPUTE_DEBT (challenges the debt's validity/accuracy — "I don't owe this", "that amount is wrong", "I never opened this account") from ordinary negotiation pushback (acknowledges the debt but can't/won't pay full — "that's too much", "I can only do $200/month").
- When an offer is on the table, classify the reply to it carefully:
  - ACCEPT = clear agreement to the specific offer: "yes", "ok I'll take it", "that works", "let's do it", "go ahead", "confirm", "sounds good".
  - REJECT = declining OR pushing for a better deal OR hesitation: "no", "that's still too high", "can you do better?", "is that the best you can do?", "I can't manage that", "anything lower?". A question that asks for a better price is REJECT, NOT ASK_QUESTION.
  - PROPOSE_AMOUNT = names a specific dollar amount ("I can do $2,000", "$150 a month" → amount=150, cadence=monthly).
- REQUEST_PLAN = wants to pay over time. If they give a COUNT of payments/months ("4 payments", "over 6 months", "in 3 installments", "let's do 4", "make it 3"), set slots.months to that integer and use action REQUEST_PLAN (NOT PROPOSE_AMOUNT — a count of payments is not a dollar amount). If they give a per-month dollar amount ("$150 a month"), set slots.amount and slots.cadence="monthly". When a payment plan is already on the table, a bare number like "4" almost always means the number of payments → REQUEST_PLAN with slots.months.
- ASK_QUESTION is only for genuine information requests (balance, who the creditor is, account status) — not for haggling.
- HARDSHIP is ONLY a serious hardship event that prevents paying anything (e.g. "I had a stroke and can't put anything toward this", "I lost my job and have no income"). Ordinary "I can't pay the whole thing right now" / "I can't afford the full amount" is NOT hardship — that is CANNOT_PAY_FULL.
- Set confidence in [0,1]. If unsure or ambiguous, use low confidence and/or UNCLEAR. Never guess.
- Output JSON only. Never address the consumer.`;

export async function classify(input: {
  transcript: ChatMessage[];
  latestMessage: string;
  fsmState: string;
  allowedActions: string[];
  offerOnTable?: string;
  authExpecting?: string; // the identity factor currently being requested
}): Promise<NLUResult> {
  const context = [
    `Current state: ${input.fsmState}`,
    `Allowed actions: ${input.allowedActions.join(", ")}`,
    input.offerOnTable ? `Offer on the table: ${input.offerOnTable}` : null,
    input.authExpecting
      ? `We are verifying identity (we just asked for: ${input.authExpecting}). Carefully extract EVERY identity factor that appears ANYWHERE in the message into slots.authFields — not only the one we asked for. Fields: accountRef (e.g. "MRS-204418"), firstName, lastName, last4ssn, zip. Disambiguation: a 5-digit number is the ZIP; a 4-digit number is the SSN last-4. If the whole message is a single bare value, map it to the field we just asked for. Split any full name into firstName + lastName. Return SSN and ZIP as digit strings.`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Provide recent conversation so intent is judged in context, not in isolation.
  const history = input.transcript
    .slice(-CONFIG.llm.nluHistoryTurns)
    .map((m) => ({
      role: (m.role === "consumer" ? "user" : "assistant") as "user" | "assistant",
      content: m.content,
    }));

  const { object } = await generateObject({
    model: model(),
    schema: NLUSchema,
    system: SYSTEM,
    messages: [
      ...history,
      {
        role: "user",
        content: `${input.latestMessage}\n\n---\n${context}\n\nClassify the LAST consumer message.`,
      },
    ],
  });
  return object;
}
