// Output Validator (design §13, Layer 3) — the outbound backstop. Runs
// server-side on NLG output before it reaches the consumer. Every currency
// amount, percentage, month/payment count, and date in the text must be in the
// turn's authorized set (assembled from engine results + disclosures). Any
// unauthorized token → block, substitute a safe fallback, log OUTPUT_BLOCKED.

export interface AuthorizedSet {
  amountsCents: number[];
  percents: number[]; // whole or fractional, e.g. 35
  counts: number[]; // authorized month / payment counts
  dates: string[]; // ISO and/or display forms
}

export interface ValidationResult {
  ok: boolean;
  offending?: { kind: string; token: string };
}

export const EMPTY_AUTHORIZED: AuthorizedSet = {
  amountsCents: [],
  percents: [],
  counts: [],
  dates: [],
};

function currencyToCents(token: string): number {
  const n = Number(token.replace(/[$,\s]/g, ""));
  return Math.round(n * 100);
}

/** Validate model output against the authorized token set for this turn. */
export function validateOutput(text: string, auth: AuthorizedSet): ValidationResult {
  // 1. Currency — strict: every $amount must be authorized.
  const currency = text.match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g) ?? [];
  for (const tok of currency) {
    if (!auth.amountsCents.includes(currencyToCents(tok))) {
      return { ok: false, offending: { kind: "currency", token: tok } };
    }
  }

  // 2. Percentages — strict.
  const pcts = text.match(/\b\d+(?:\.\d+)?\s?%/g) ?? [];
  for (const tok of pcts) {
    const v = Number(tok.replace(/[%\s]/g, ""));
    if (!auth.percents.includes(v)) {
      return { ok: false, offending: { kind: "percent", token: tok } };
    }
  }

  // 3. Month / payment counts — strict ("18 months", "17 payments").
  const counts = [...text.matchAll(/\b(\d+)\s+(months?|payments?|installments?)\b/gi)];
  for (const m of counts) {
    const v = Number(m[1]);
    if (!auth.counts.includes(v)) {
      return { ok: false, offending: { kind: "count", token: m[0] } };
    }
  }

  // 4. Dates — ISO and "Month D, YYYY".
  const isoDates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  const longDates =
    text.match(
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/g,
    ) ?? [];
  for (const tok of [...isoDates, ...longDates]) {
    if (!auth.dates.includes(tok)) {
      return { ok: false, offending: { kind: "date", token: tok } };
    }
  }

  return { ok: true };
}

/** Build an authorized set from facts the orchestrator already computed. */
export function buildAuthorized(
  parts: Partial<AuthorizedSet>,
): AuthorizedSet {
  return {
    amountsCents: parts.amountsCents ?? [],
    percents: parts.percents ?? [],
    counts: parts.counts ?? [],
    dates: parts.dates ?? [],
  };
}
