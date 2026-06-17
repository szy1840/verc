// Money math primitives. Everything is integer cents. Installment schedules
// ALWAYS sum to exactly the principal — never over/under-collect (design §8).

import { CONFIG } from "../config.ts";

export const VERIFY_FUNDS_THRESHOLD_CENTS = CONFIG.payment.verifyFundsThresholdCents; // > $1,500 (SOP §3.1)

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/** Settled lump for a given discount. settled = balance − round(balance × bps). */
export function settledAmountCents(balanceCents: number, discountBps: number): number {
  const discountCents = Math.round((balanceCents * discountBps) / 10_000);
  return balanceCents - discountCents;
}

/** The lowest lump we may accept = settled at the cap. Paying less is forbidden. */
export function allowedMinSettlementCents(balanceCents: number, capBps: number): number {
  return settledAmountCents(balanceCents, capBps);
}

/** Actual discount (bps) represented by a settled amount, relative to balance. */
export function impliedDiscountBps(balanceCents: number, settledCents: number): number {
  return Math.round(((balanceCents - settledCents) / balanceCents) * 10_000);
}

/**
 * Build a schedule when the consumer proposes a MONTHLY amount Y.
 * Pay Y for ceil(P/Y)-1 months; final = P − Y×(n−1) (≤ Y). Sums to P exactly.
 * E.g. P=$2,675, Y=$150 → 17×$150 + $125 (NOT $150×18=$2,700).
 */
export function scheduleByMonthly(principalCents: number, monthlyCents: number): number[] {
  if (monthlyCents <= 0) throw new Error("monthly must be > 0");
  const n = Math.ceil(principalCents / monthlyCents);
  const schedule = new Array(n - 1).fill(monthlyCents);
  schedule.push(principalCents - monthlyCents * (n - 1)); // remainder, ≤ monthly
  return schedule;
}

/**
 * Build a schedule when the consumer proposes a NUMBER OF MONTHS M.
 * monthly = floor(P/M); final installment takes the remainder (≥ monthly).
 * E.g. P=$2,675, M=18 → 17×$148 + $159. Sums to P exactly.
 */
export function scheduleByMonths(principalCents: number, months: number): number[] {
  if (months <= 0) throw new Error("months must be > 0");
  const monthly = Math.floor(principalCents / months);
  const schedule = new Array(months - 1).fill(monthly);
  schedule.push(principalCents - monthly * (months - 1)); // remainder, ≥ monthly
  return schedule;
}

/** Minimum monthly to clear the principal within maxMonths = ceil(P / maxMonths). */
export function minMonthlyCents(principalCents: number, maxMonths: number): number {
  return Math.ceil(principalCents / maxMonths);
}

/** Any single scheduled payment over the threshold requires funds verification. */
export function scheduleNeedsVerifyFunds(schedule: number[]): boolean {
  return schedule.some((p) => p > VERIFY_FUNDS_THRESHOLD_CENTS);
}
