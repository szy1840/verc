import type { Account, FlagCode } from "./types.ts";

// "Escalate — do not negotiate" (design §10, SOP §4). Two trigger sources:
//   1. Account-borne flags / non-serviced region — deterministic, checked at the
//      post-auth gate before any account disclosure beyond the Mini-Miranda.
//   2. Conversation-surfaced escalation intents — detected by NLU in any state.

// SOP §5.6 — regions we do not collect in.
export const NON_SERVICED_REGIONS = new Set([
  "AA", "AE", "AP", // Armed Forces
  "GU", // Guam
  "PR", // Puerto Rico
  "VI", // U.S. Virgin Islands
  "MP", // Northern Mariana Islands
  "FM", "MH", "PW", // Micronesia, Marshall Islands, Palau
]);

export interface EscalationDecision {
  escalate: boolean;
  code?: string; // SOP §4.1 code, "REGION", or "REQUEST_HUMAN" / "AUTH_FAILED"
  reason?: string; // human-readable
  recommendedAction?: string; // routing hint for the handoff package
}

const FLAG_META: Record<FlagCode, { reason: string; action: string }> = {
  BKY: { reason: "Bankruptcy reported", action: "Route to the bankruptcy desk; place on hold." },
  DEC: { reason: "Deceased borrower reported", action: "Route to the estate/deceased team; cease collection." },
  MIL: { reason: "Active-duty military reported", action: "Apply SCRA handling; route to a specialist." },
  FRA: { reason: "Fraud / identity theft reported", action: "Route to the fraud team; place on hold." },
  VOD: { reason: "Verification of debt requested", action: "Log VOD; stop collection until verified." },
  DSP: { reason: "Debt disputed", action: "Treat as a dispute hold; route for processing." },
  CDP: { reason: "Cease & desist / do-not-contact", action: "Honor the do-not-contact request; cease contact." },
  HRA: { reason: "Hardship reported", action: "Route to a hardship specialist." },
  APP: { reason: "Claims account paid/settled previously", action: "Route to verify prior resolution." },
  MOS: { reason: "Moved out of state/country", action: "Re-check jurisdiction; route to a specialist." },
  DBM: { reason: "Debt manager / consolidation program", action: "Route to the third-party/representation desk." },
  ATTY: { reason: "Attorney-represented", action: "Cease direct contact; route to legal/representation desk." },
};

/**
 * Deterministic post-auth gate (design §4/§10). Run on auth success BEFORE any
 * disclosure beyond the Mini-Miranda. A flag or non-serviced region → hold &
 * escalate; the balance-bearing collector statement is never reached.
 */
export function detectAccountEscalation(account: Account): EscalationDecision {
  if (account.flags.length > 0) {
    const code = account.flags[0];
    const meta = FLAG_META[code];
    return {
      escalate: true,
      code,
      reason: meta.reason,
      recommendedAction: meta.action,
    };
  }
  if (NON_SERVICED_REGIONS.has(account.stateCode)) {
    return {
      escalate: true,
      code: "REGION",
      reason: `Account address is in a non-serviced region (${account.stateCode})`,
      recommendedAction: "Do not collect; route per non-serviced-region policy.",
    };
  }
  return { escalate: false };
}

// Conversation-surfaced escalation intents → SOP §4.1 codes (design §10).
export const INTENT_TO_CODE: Record<string, FlagCode | "REQUEST_HUMAN"> = {
  DECLARE_BANKRUPTCY: "BKY",
  REPORT_DECEASED: "DEC",
  DECLARE_MILITARY: "MIL",
  REPORT_FRAUD: "FRA",
  REQUEST_VOD: "VOD",
  DISPUTE_DEBT: "DSP",
  CEASE_AND_DESIST: "CDP",
  HARDSHIP: "HRA",
  CLAIM_PRIOR_RESOLUTION: "APP",
  REPORT_RELOCATION: "MOS",
  ATTORNEY_REPRESENTED: "ATTY",
  REQUEST_HUMAN: "REQUEST_HUMAN",
};

export const ESCALATION_INTENTS = new Set(Object.keys(INTENT_TO_CODE));

export function intentEscalation(intent: string): EscalationDecision {
  const code = INTENT_TO_CODE[intent];
  if (!code) return { escalate: false };
  if (code === "REQUEST_HUMAN") {
    return {
      escalate: true,
      code: "REQUEST_HUMAN",
      reason: "Consumer requested a human agent",
      recommendedAction: "Warm-transfer to a live agent with full context.",
    };
  }
  const meta = FLAG_META[code];
  return { escalate: true, code, reason: meta.reason, recommendedAction: meta.action };
}

/** Deterministic, number-free escalation message (safe fallback / verbatim). */
export function escalationMessage(decision: EscalationDecision, authed: boolean): string {
  if (decision.code === "REQUEST_HUMAN") {
    return "Of course — I'm connecting you with a specialist who can help. Please hold for a moment.";
  }
  if (!authed) {
    return "I'm not able to continue here, but I can connect you with a specialist who can assist you further. Please hold for a moment.";
  }
  if (decision.code === "REGION") {
    return "Thank you. Based on your account, I'm not able to assist with this here. I'm connecting you with a specialist who can help. Please hold for a moment.";
  }
  if (decision.code === "DEC") {
    return "I'm very sorry for your loss. I'm going to place this account on hold and connect you with a specialist who handles these matters. Please hold for a moment.";
  }
  if (decision.code === "CDP" || decision.code === "ATTY") {
    return "Understood — I'll note that on the account and place it on hold. I'm connecting you with a specialist. Please hold for a moment.";
  }
  return "Thank you for letting me know. I'm placing your account on hold and connecting you with a specialist who can help. Please hold for a moment.";
}
