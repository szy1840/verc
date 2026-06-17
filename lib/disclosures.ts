import type { Account, Portfolio } from "./types.ts";
import { formatCents } from "./engine/money.ts";

// All required disclosures are emitted VERBATIM / from templates by code — never
// LLM-generated (design §6, SOP §1.1 & §2). The orchestrator marks these as
// verbatim so the NLG layer outputs them unchanged (or bypasses the LLM).

export const MINI_MIRANDA =
  "This is a communication from a debt collector. This is an attempt to collect a debt, and any information obtained, including this call recording, will be used for that purpose.";

export const RECORDING_CONSENT =
  "Before I proceed, this conversation may be monitored and recorded; by continuing you are providing your consent.";

export const PRE_LEGAL_DISCLOSURE =
  "Please be advised that your account has been placed with our office in a pre-legal status. Failure to resolve this matter may result in your account being reviewed by an attorney in your state for possible legal action to collect the balance due.";

export const CLOSING_STATEMENT =
  "Is there anything else I can help with today? If you have further questions, you can reach us through the agency's published contact channels.";

export function miniMiranda(portfolio: Portfolio): string {
  return portfolio.miniMirandaVariant ?? MINI_MIRANDA;
}

/**
 * Pre-legal language is recited only for pre-legal portfolios, and is suppressed
 * when a prior arrangement was breached or for an NSF payment (SOP §2.4).
 */
export function shouldRecitePreLegal(account: Account, portfolio: Portfolio): boolean {
  return (
    portfolio.isPreLegal &&
    !account.priorArrangementBreached &&
    !account.nsfPayment
  );
}

function formatReceiveDate(iso: string): string {
  // ISO date only; build the display string without timezone drift.
  const [y, m, d] = iso.split("-").map(Number);
  const month = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][m - 1];
  return `${month} ${d}, ${y}`;
}

/**
 * Collector statement (SOP §2.3). First appearance of an amount and a date —
 * both injected from the account record, never generated. The returned `facts`
 * is the authorized set for the Output Validator (design §6/§13).
 */
export function collectorStatement(
  account: Account,
  portfolio: Portfolio,
): { text: string; facts: Record<string, unknown> } {
  const balance = formatCents(account.balanceCents);
  const date = formatReceiveDate(account.receiveDate);
  const text =
    `I am with Meridian Recovery Services on behalf of ${portfolio.clientName} in regard to your ` +
    `${account.originalCreditor} account. Your account was placed with our office as of ${date} ` +
    `and reflects a balance of ${balance}. It is my goal to resolve this with you in a courteous ` +
    `and professional manner. How can I help you resolve your balance today?`;
  return {
    text,
    facts: {
      balanceCents: account.balanceCents,
      balance,
      receiveDate: account.receiveDate,
      receiveDateDisplay: date,
      clientName: portfolio.clientName,
      originalCreditor: account.originalCreditor,
    },
  };
}
