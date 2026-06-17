import { test } from "node:test";
import assert from "node:assert/strict";
import type { Account } from "../types.ts";
import {
  evaluateSettlement,
  evaluateInstallments,
  effectiveMaxMonths,
} from "./negotiation.ts";
import {
  scheduleByMonthly,
  scheduleByMonths,
  settledAmountCents,
} from "./money.ts";
import { PORTFOLIOS } from "./portfolios.ts";

function acct(over: Partial<Account> = {}): Account {
  return {
    accountRef: "MRS-TEST",
    firstName: "Test",
    lastName: "User",
    last4ssn: "0000",
    zip: "00000",
    portfolioId: "P-300",
    originalCreditor: "OC",
    currentCreditor: "CC",
    balanceCents: 267_500, // $2,675
    receiveDate: "2026-04-05",
    flags: [],
    stateCode: "GA",
    ...over,
  };
}

// --- Money math: schedules sum to EXACTLY the principal ---

test("scheduleByMonthly sums to principal; no over-collection", () => {
  const s = scheduleByMonthly(267_500, 15_000); // $2,675 at $150/mo
  assert.equal(s.length, 18);
  assert.equal(s.slice(0, 17).every((p) => p === 15_000), true);
  assert.equal(s[17], 12_500); // final $125 (NOT $150 → would be $2,700)
  assert.equal(s.reduce((a, b) => a + b, 0), 267_500);
});

test("scheduleByMonths sums to principal; final takes remainder", () => {
  const s = scheduleByMonths(267_500, 18);
  assert.equal(s.length, 18);
  assert.equal(s[0], 14_861); // floor(267500/18)
  assert.equal(s.reduce((a, b) => a + b, 0), 267_500);
  assert.ok(s[17] >= s[0]); // final >= monthly
});

test("scheduleByMonthly handles exact division (final === monthly)", () => {
  const s = scheduleByMonthly(120_000, 30_000); // $1,200 at $300/mo → 4×$300
  assert.deepEqual(s, [30_000, 30_000, 30_000, 30_000]);
});

// --- Settlement caps: never exceed the portfolio ceiling ---

test("proactive settlement starts at ladder tier 0, not the cap", () => {
  const r = evaluateSettlement(acct({ portfolioId: "P-100", balanceCents: 100_000 }));
  // P-100 ladder [15,25,35] → tier 0 = 15% off → $850
  assert.equal(r.amountCents, 85_000);
  assert.equal(r.discountAppliedBps, 1500);
});

test("consumer lump within cap is accepted", () => {
  const a = acct({ portfolioId: "P-200", balanceCents: 100_000 }); // 50% cap
  const r = evaluateSettlement(a, 60_000); // 40% off → within cap
  assert.equal(r.decision, "accept");
  assert.equal(r.amountCents, 60_000);
});

test("consumer lump below cap floor is countered at the floor, never lower", () => {
  const a = acct({ portfolioId: "P-200", balanceCents: 100_000 }); // 50% cap → floor $500
  const r = evaluateSettlement(a, 30_000); // asks 70% off
  assert.equal(r.decision, "counter");
  assert.equal(r.amountCents, 50_000); // floor = balance × (1 − 50%)
  assert.equal(r.discountAppliedBps, 5000);
});

test("settled amount never gives more than the cap discount across portfolios", () => {
  for (const p of Object.values(PORTFOLIOS)) {
    const balance = 543_21;
    const floor = settledAmountCents(balance, p.maxDiscountBps);
    const discountGiven = balance - floor;
    const maxDiscount = Math.round((balance * p.maxDiscountBps) / 10_000);
    assert.ok(discountGiven <= maxDiscount, `${p.portfolioId} over-discounted`);
  }
});

// --- Installments: rung bounds + F&C unlock ---

test("BIF installments are bounded at 2-4 months regardless of profile", () => {
  const a = acct({ portfolioId: "P-300" }); // 18mo portfolio cap
  assert.equal(effectiveMaxMonths(a, "BIF_INSTALLMENTS", true), 4);
  const r = evaluateInstallments(a, { rung: "BIF_INSTALLMENTS", principalCents: 267_500, months: 12 }, true);
  assert.equal(r.decision, "counter");
  assert.equal(r.months, 4); // clamped to the 4-payment max
  assert.equal(r.schedule.reduce((x, y) => x + y, 0), 267_500);
});

test("PPA without profile caps at 6 months and offers F&C to unlock", () => {
  const a = acct({ portfolioId: "P-300" }); // cap 18
  assert.equal(effectiveMaxMonths(a, "PPA", false), 6);
  const r = evaluateInstallments(a, { rung: "PPA", principalCents: 267_500, monthlyAmountCents: 15_000 }, false);
  // 18 months needed > 6 → offer F&C
  assert.equal(r.decision, "offer_fc");
});

test("PPA WITH profile unlocks the full portfolio cap and honors the monthly", () => {
  const a = acct({ portfolioId: "P-300" });
  assert.equal(effectiveMaxMonths(a, "PPA", true), 18);
  const r = evaluateInstallments(a, { rung: "PPA", principalCents: 267_500, monthlyAmountCents: 15_000 }, true);
  assert.equal(r.decision, "accept");
  assert.equal(r.months, 18);
  assert.equal(r.schedule[17], 12_500); // final $125 — exact, no over-collect
  assert.equal(r.schedule.reduce((x, y) => x + y, 0), 267_500);
});

test("PPA without profile, declined F&C, counters at minimum monthly over 6mo", () => {
  const a = acct({ portfolioId: "P-300", balanceCents: 267_500 });
  // months proposal exceeding 6 with profile=false but principal small enough
  // that the F&C-unlock branch still triggers for months>cap; test the monthly
  // counter path with a portfolio whose cap === 6 so no F&C offer is possible.
  const auto = acct({ portfolioId: "P-100", balanceCents: 120_000 }); // cap 6, no unlock
  const r = evaluateInstallments(auto, { rung: "PPA", principalCents: 120_000, monthlyAmountCents: 10_000 }, false);
  // 12 months needed > 6, portfolio cap === 6 so no F&C → counter at min monthly
  assert.equal(r.decision, "counter");
  assert.equal(r.months, 6);
  assert.equal(r.schedule.reduce((x, y) => x + y, 0), 120_000);
});
