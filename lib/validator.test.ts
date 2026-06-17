import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOutput, buildAuthorized } from "./validator.ts";

const auth = buildAuthorized({
  amountsCents: [85_000, 100_000], // $850, $1,000 authorized
  percents: [15],
  counts: [6],
  dates: ["March 12, 2026", "2026-03-12"],
});

test("passes when every figure is authorized", () => {
  const r = validateOutput(
    "Your balance is $1,000.00 and I can settle for $850 — that's 15% off, over 6 months.",
    auth,
  );
  assert.equal(r.ok, true);
});

test("blocks a fabricated currency amount", () => {
  const r = validateOutput("I can settle for $500 today.", auth);
  assert.equal(r.ok, false);
  assert.equal(r.offending?.kind, "currency");
});

test("blocks a fabricated discount percentage", () => {
  const r = validateOutput("I can give you 60% off.", auth);
  assert.equal(r.ok, false);
  assert.equal(r.offending?.kind, "percent");
});

test("blocks a fabricated plan length", () => {
  const r = validateOutput("We can spread that over 24 months.", auth);
  assert.equal(r.ok, false);
  assert.equal(r.offending?.kind, "count");
});

test("blocks a fabricated date", () => {
  const r = validateOutput("Your account was placed on January 1, 2020.", auth);
  assert.equal(r.ok, false);
  assert.equal(r.offending?.kind, "date");
});

test("normalizes currency formatting ($850 == $850.00)", () => {
  assert.equal(validateOutput("Pay $850.00.", auth).ok, true);
  assert.equal(validateOutput("Pay $850.", auth).ok, true);
});
