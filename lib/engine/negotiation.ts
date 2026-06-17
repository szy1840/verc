import type {
  Account,
  InstallmentResult,
  NegotiationStage,
  SettlementResult,
} from "../types.ts";
import { CONFIG } from "../config.ts";
import { getPortfolio } from "./portfolios.ts";
import {
  allowedMinSettlementCents,
  impliedDiscountBps,
  minMonthlyCents,
  scheduleByMonthly,
  scheduleByMonths,
  scheduleNeedsVerifyFunds,
  settledAmountCents,
  VERIFY_FUNDS_THRESHOLD_CENTS,
} from "./money.ts";

// The deterministic "truth" layer for all resolution math (design §8). The LLM
// never produces a number; these pure functions do. Every result carries the
// cap used + a reason, fed straight into the audit log.

/**
 * Proactive settlement offer following the discount ladder ("best you can do?").
 * Offers ladder[tierIndex]; advancing the tier happens in the orchestrator on
 * rejection. Clamped to the last tier (= cap) — structurally cannot exceed it.
 */
export function proactiveSettlementOffer(
  account: Account,
  tierIndex: number,
): SettlementResult {
  const p = getPortfolio(account.portfolioId);
  const idx = Math.min(Math.max(tierIndex, 0), p.discountLadderBps.length - 1);
  const discountBps = p.discountLadderBps[idx];
  const amountCents = settledAmountCents(account.balanceCents, discountBps);
  return {
    decision: "counter",
    amountCents,
    discountAppliedBps: discountBps,
    capBps: p.maxDiscountBps,
    verifyFunds: amountCents > VERIFY_FUNDS_THRESHOLD_CENTS,
    reason: `proactive settlement at ladder tier ${idx} (${discountBps / 100}% off, within ${p.maxDiscountBps / 100}% cap)`,
  };
}

/**
 * Evaluate a settlement. With no proposed amount → proactive tier-0 offer.
 * With a proposed amount: accept if at/above the cap floor, else counter at the
 * floor. The settlement cap is INDEPENDENT of F&C (design §9) — no hasProfile.
 */
export function evaluateSettlement(
  account: Account,
  proposedAmountCents?: number,
): SettlementResult {
  const p = getPortfolio(account.portfolioId);
  const floor = allowedMinSettlementCents(account.balanceCents, p.maxDiscountBps);

  if (proposedAmountCents == null) {
    return proactiveSettlementOffer(account, 0);
  }

  if (proposedAmountCents >= floor) {
    // Within cap → take it. Compliant and low-friction.
    return {
      decision: "accept",
      amountCents: proposedAmountCents,
      discountAppliedBps: impliedDiscountBps(account.balanceCents, proposedAmountCents),
      capBps: p.maxDiscountBps,
      verifyFunds: proposedAmountCents > VERIFY_FUNDS_THRESHOLD_CENTS,
      reason: "consumer-proposed lump within portfolio discount cap; accepted",
    };
  }

  // Below the floor → counter at the floor ("best we can do").
  return {
    decision: "counter",
    amountCents: floor,
    discountAppliedBps: p.maxDiscountBps,
    capBps: p.maxDiscountBps,
    verifyFunds: floor > VERIFY_FUNDS_THRESHOLD_CENTS,
    reason: `proposed amount below the ${p.maxDiscountBps / 100}% cap floor; countered at floor`,
  };
}

interface InstallmentRequest {
  rung: NegotiationStage; // BIF_INSTALLMENTS | SIF_INSTALLMENTS | PPA
  principalCents: number; // full balance, or settled amount for SIF installments
  monthlyAmountCents?: number;
  months?: number;
}

/** maxMonths bound per rung (design §8). PPA depends on F&C; BIF/SIF fixed 2–4. */
export function effectiveMaxMonths(
  account: Account,
  rung: NegotiationStage,
  hasProfile: boolean,
): number {
  if (rung === "PPA") {
    const cap = getPortfolio(account.portfolioId).maxPlanMonths;
    return hasProfile ? cap : Math.min(cap, CONFIG.negotiation.noProfilePpaCapMonths);
  }
  // BIF_INSTALLMENTS / SIF_INSTALLMENTS
  return CONFIG.negotiation.bifSifInstallmentMaxMonths;
}

/**
 * Core installment solver. Honors a proposed monthly or month-count, building a
 * schedule that sums to EXACTLY the principal. Counters at the minimum monthly
 * (or max months) when the request exceeds the bound; for PPA-without-profile,
 * signals that gathering F&C could unlock a longer term.
 */
export function evaluateInstallments(
  account: Account,
  req: InstallmentRequest,
  hasProfile: boolean,
): InstallmentResult {
  const { rung, principalCents } = req;
  const maxMonths = effectiveMaxMonths(account, rung, hasProfile);
  const minMonths = CONFIG.negotiation.installmentMinMonths; // floor of payments per plan

  const build = (schedule: number[], reason: string, decision: InstallmentResult["decision"]): InstallmentResult => ({
    decision,
    stage: rung,
    months: schedule.length,
    monthlyCents: schedule[0],
    schedule,
    maxMonths,
    principalCents,
    verifyFunds: scheduleNeedsVerifyFunds(schedule),
    reason,
  });

  // Consumer proposes a monthly amount.
  if (req.monthlyAmountCents != null) {
    const Y = req.monthlyAmountCents;
    const monthsNeeded = Math.ceil(principalCents / Y);

    if (monthsNeeded <= maxMonths) {
      return build(
        scheduleByMonthly(principalCents, Y),
        `honored proposed monthly within ${maxMonths}-month bound`,
        "accept",
      );
    }

    // Too many months. For PPA without a profile, offer F&C to unlock the cap.
    const portfolioCap = getPortfolio(account.portfolioId).maxPlanMonths;
    if (rung === "PPA" && !hasProfile && portfolioCap > CONFIG.negotiation.noProfilePpaCapMonths) {
      return {
        decision: "offer_fc",
        stage: rung,
        months: monthsNeeded,
        monthlyCents: Y,
        schedule: [],
        maxMonths,
        principalCents,
        verifyFunds: false,
        reason: `proposed plan needs ${monthsNeeded} months > ${maxMonths}-month cap (no profile); F&C could unlock up to ${portfolioCap} months`,
      };
    }

    // Otherwise counter at the minimum monthly to fit the bound.
    const minMonthly = minMonthlyCents(principalCents, maxMonths);
    return build(
      scheduleByMonthly(principalCents, minMonthly),
      `proposed monthly too low for ${maxMonths}-month bound; countered at minimum monthly`,
      "counter",
    );
  }

  // Consumer proposes a number of months.
  if (req.months != null) {
    const M = Math.max(req.months, minMonths);
    if (M <= maxMonths) {
      return build(
        scheduleByMonths(principalCents, M),
        `honored proposed ${M}-month plan within bound`,
        "accept",
      );
    }
    // For PPA without profile, a longer term could be unlocked via F&C.
    const portfolioCap = getPortfolio(account.portfolioId).maxPlanMonths;
    if (rung === "PPA" && !hasProfile && portfolioCap > CONFIG.negotiation.noProfilePpaCapMonths) {
      return {
        decision: "offer_fc",
        stage: rung,
        months: M,
        monthlyCents: minMonthlyCents(principalCents, M),
        schedule: [],
        maxMonths,
        principalCents,
        verifyFunds: false,
        reason: `proposed ${M} months > ${maxMonths}-month cap (no profile); F&C could unlock up to ${portfolioCap} months`,
      };
    }
    return build(
      scheduleByMonths(principalCents, maxMonths),
      `proposed ${M} months exceeds ${maxMonths}-month bound; countered at max`,
      "counter",
    );
  }

  // No specifics → propose the standard plan at the bound (max months).
  return build(
    scheduleByMonths(principalCents, maxMonths),
    `default ${rung} plan over ${maxMonths} months`,
    "counter",
  );
}
