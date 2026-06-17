// Central tunable configuration. Every value has a default that matches the
// design; all can be overridden via environment variables (e.g. in .env.local)
// without touching code. Portfolio caps/ladders live in engine/portfolios.ts.

function intEnv(name: string, dflt: number): number {
  const v = process.env[name];
  if (v == null || v.trim() === "") return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function floatEnv(name: string, dflt: number): number {
  const v = process.env[name];
  if (v == null || v.trim() === "") return dflt;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

export const CONFIG = {
  llm: {
    // Claude model used for both NLU and NLG.
    model: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    // How many recent transcript turns to include as context.
    nluHistoryTurns: intEnv("NLU_HISTORY_TURNS", 8),
    nlgHistoryTurns: intEnv("NLG_HISTORY_TURNS", 6),
  },
  auth: {
    // Max failed verification attempts before disclose-nothing handoff (SOP §1.4).
    maxAttempts: intEnv("AUTH_MAX_ATTEMPTS", 3),
  },
  nlu: {
    // Below this confidence, the orchestrator clarifies instead of acting (§8).
    confidenceThreshold: floatEnv("NLU_CONFIDENCE_THRESHOLD", 0.45),
  },
  negotiation: {
    // Floor on the number of installments in any plan.
    installmentMinMonths: intEnv("INSTALLMENT_MIN_MONTHS", 2),
    // BIF / SIF "in payments" bound (SOP §3.2: 2–4 payments).
    bifSifInstallmentMaxMonths: intEnv("BIF_SIF_INSTALLMENT_MAX_MONTHS", 4),
    // Plan length cap without a financial profile (SOP §3.5).
    noProfilePpaCapMonths: intEnv("NO_PROFILE_PPA_CAP_MONTHS", 6),
  },
  payment: {
    // Single payment above this requires funds verification (SOP §3.1).
    verifyFundsThresholdCents: intEnv("VERIFY_FUNDS_THRESHOLD_CENTS", 150_000),
  },
} as const;
