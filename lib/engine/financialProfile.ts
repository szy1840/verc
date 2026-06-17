import type { FinancialProfile } from "../types.ts";

// F&C completeness + affordability (design §9). Completeness is a DETERMINISTIC
// gate — the engine, not the LLM, decides whether longer plans unlock.

/**
 * Sufficient requires at least: net monthly income + housing payment +
 * vehicle payment (0 === confirmed none). All self-reported; no proof (stubbed).
 */
export function evaluateCompleteness(
  profile: Partial<FinancialProfile>,
): "incomplete" | "sufficient" {
  const hasIncome = profile.netMonthlyIncomeCents != null;
  const hasHousing = profile.housingPaymentCents != null;
  const hasVehicle = profile.vehiclePaymentsCents != null; // 0 allowed
  return hasIncome && hasHousing && hasVehicle ? "sufficient" : "incomplete";
}

/** The next still-missing required field, for the LLM to ask about (NLG only). */
export function nextMissingField(
  profile: Partial<FinancialProfile>,
): "netMonthlyIncome" | "housingPayment" | "vehiclePayments" | null {
  if (profile.netMonthlyIncomeCents == null) return "netMonthlyIncome";
  if (profile.housingPaymentCents == null) return "housingPayment";
  if (profile.vehiclePaymentsCents == null) return "vehiclePayments";
  return null;
}

/**
 * Soft affordability suggestion — NEVER a hard gate (collections maximize
 * recovery). disposable = income − housing − vehicle − other.
 */
export function disposableIncomeCents(
  profile: Partial<FinancialProfile>,
): number | null {
  if (profile.netMonthlyIncomeCents == null) return null;
  return (
    profile.netMonthlyIncomeCents -
    (profile.housingPaymentCents ?? 0) -
    (profile.vehiclePaymentsCents ?? 0) -
    (profile.otherObligationsCents ?? 0)
  );
}
