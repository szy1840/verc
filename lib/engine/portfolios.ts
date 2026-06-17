import type { Portfolio, PortfolioId } from "../types.ts";

// Portfolio config = source of truth for caps + discount ladders (design §8).
// Onboarding a new portfolio = adding one row. The LAST ladder tier always
// equals maxDiscountBps so the engine can never index past the cap.
export const PORTFOLIOS: Record<PortfolioId, Portfolio> = {
  "P-100": {
    portfolioId: "P-100",
    clientName: "Northwind Capital",
    type: "Auto / secured",
    maxDiscountBps: 3500,
    maxPlanMonths: 6,
    isPreLegal: false,
    discountLadderBps: [1500, 2500, 3500],
  },
  "P-200": {
    portfolioId: "P-200",
    clientName: "Apex Card LLC",
    type: "Credit card",
    maxDiscountBps: 5000,
    maxPlanMonths: 12,
    isPreLegal: false,
    discountLadderBps: [2000, 3500, 5000],
  },
  "P-300": {
    portfolioId: "P-300",
    clientName: "Harbor Recovery",
    type: "Personal (pre-legal)",
    maxDiscountBps: 2500,
    maxPlanMonths: 18,
    isPreLegal: true,
    discountLadderBps: [1000, 1800, 2500],
  },
};

export function getPortfolio(portfolioId: PortfolioId): Portfolio {
  const p = PORTFOLIOS[portfolioId];
  if (!p) throw new Error(`Unknown portfolio: ${portfolioId}`);
  // Invariant: ladder ends exactly at the cap (structural guarantee).
  const last = p.discountLadderBps[p.discountLadderBps.length - 1];
  if (last !== p.maxDiscountBps) {
    throw new Error(`Portfolio ${portfolioId} ladder must end at maxDiscountBps`);
  }
  return p;
}
