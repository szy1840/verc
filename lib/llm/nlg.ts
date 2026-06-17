import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { ChatMessage } from "../db/store.ts";
import type { AuthorizedSet } from "../validator.ts";
import { CONFIG } from "../config.ts";

// NLG: the orchestrator decides WHAT to say; the LLM only phrases it warmly
// (design §12). Verbatim disclosures bypass the LLM entirely. Every fact-carrying
// directive ships a deterministic `fallbackText` that is always validator-safe.

function model() {
  return anthropic(CONFIG.llm.model);
}

export interface Directive {
  intent: string;
  seedText: string; // deterministic phrasing; the always-safe fallback
  verbatim?: boolean; // if true, output seedText exactly (no LLM)
  facts?: Record<string, unknown>; // values the model may use (context only)
  authorized?: AuthorizedSet; // the validator allow-list for this turn
}

const SYSTEM = `You are the voice of the web chat assistant for Meridian Recovery Services, a third-party debt-collection agency. You help consumers resolve past-due accounts in a courteous, calm, and empathetic way — many people you speak with are stressed about money. Be concise and human.

ABSOLUTE RULES:
- You will be given a draft message. Rephrase it to sound warm and natural, but keep EVERY amount, percentage, date, month/payment count, and policy statement EXACTLY as written in the draft.
- NEVER introduce any number, amount, date, discount, term, or policy that is not in the draft.
- Make no promises, threats, or legal statements. Give no legal or financial advice.
- Keep it short (1-3 sentences). Output only the message to the consumer.`;

/** Render a directive to consumer-facing text. Verbatim directives skip the LLM. */
export async function render(
  directive: Directive,
  transcript: ChatMessage[],
): Promise<string> {
  if (directive.verbatim) return directive.seedText;

  try {
    const history = transcript.slice(-CONFIG.llm.nlgHistoryTurns).map((m) => ({
      role: (m.role === "consumer" ? "user" : "assistant") as "user" | "assistant",
      content: m.content,
    }));

    const { text } = await generateText({
      model: model(),
      system: SYSTEM,
      messages: [
        ...history,
        {
          role: "user",
          content:
            `Draft message to rephrase (keep all figures exact):\n"""${directive.seedText}"""` +
            (directive.facts
              ? `\n\nFigures you may reference (do not add others): ${JSON.stringify(directive.facts)}`
              : ""),
        },
      ],
    });
    return text.trim() || directive.seedText;
  } catch {
    // LLM failure → deterministic safe fallback. The conversation never breaks.
    return directive.seedText;
  }
}
