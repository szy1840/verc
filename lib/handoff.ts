import type { Account, NegotiationState, FinancialProfile } from "./types.ts";
import type { ChatMessage } from "./db/store.ts";
import { getPortfolio } from "./engine/portfolios.ts";
import { formatCents } from "./engine/money.ts";

// Clean handoff with a complete context package (design §10). Auth-aware
// redaction: if escalation happens BEFORE auth, the package carries transcript +
// reason + audit only — NO account details (SOP §1.4). Delivery to a live agent
// is STUBBED; the package is real and persisted.

export interface HandoffPackage {
  reason: string;
  code?: string;
  triggeredAt: string;
  fsmStateAtEscalation: string;
  authStatus: "authenticated" | "unauthenticated";
  consentRecord: { consentAt: string | null };
  fullTranscript: ChatMessage[];
  auditTrail: unknown[];
  recommendedAction?: string;
  // Only present when authenticated:
  accountSummary?: {
    accountRef: string;
    portfolio: string;
    client: string;
    balance: string;
    originalCreditor: string;
    flags: string[];
    stateCode: string;
  };
  negotiationState?: NegotiationState | null;
  financialProfile?: FinancialProfile | null;
}

export function buildHandoffPackage(input: {
  reason: string;
  code?: string;
  recommendedAction?: string;
  triggeredAt: string;
  fsmState: string;
  consentAt: string | null;
  transcript: ChatMessage[];
  audit: unknown[];
  account?: Account | null; // present only if authenticated
  negotiation?: NegotiationState | null;
  financialProfile?: FinancialProfile | null;
}): HandoffPackage {
  const authed = !!input.account;
  const pkg: HandoffPackage = {
    reason: input.reason,
    code: input.code,
    triggeredAt: input.triggeredAt,
    fsmStateAtEscalation: input.fsmState,
    authStatus: authed ? "authenticated" : "unauthenticated",
    consentRecord: { consentAt: input.consentAt },
    fullTranscript: input.transcript,
    auditTrail: input.audit,
    recommendedAction: input.recommendedAction,
  };

  // Auth-aware redaction — never leak account detail downstream pre-auth.
  if (authed && input.account) {
    const p = getPortfolio(input.account.portfolioId);
    pkg.accountSummary = {
      accountRef: input.account.accountRef,
      portfolio: input.account.portfolioId,
      client: p.clientName,
      balance: formatCents(input.account.balanceCents),
      originalCreditor: input.account.originalCreditor,
      flags: input.account.flags,
      stateCode: input.account.stateCode,
    };
    pkg.negotiationState = input.negotiation ?? null;
    pkg.financialProfile = input.financialProfile ?? null;
  }

  return pkg;
}
