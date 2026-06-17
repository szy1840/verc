import { store } from "./db/store.ts";
import type { SessionRecord, ChatMessage } from "./db/store.ts";
import type {
  Account,
  AuthFields,
  FinancialProfile,
  FsmState,
  NegotiationState,
  Offer,
} from "./types.ts";
import { getPortfolio } from "./engine/portfolios.ts";
import { dollarsToCents, formatCents } from "./engine/money.ts";
import {
  evaluateSettlement,
  evaluateInstallments,
  proactiveSettlementOffer,
} from "./engine/negotiation.ts";
import {
  evaluateCompleteness,
  nextMissingField,
} from "./engine/financialProfile.ts";
import {
  MINI_MIRANDA,
  RECORDING_CONSENT,
  collectorStatement,
  miniMiranda,
  shouldRecitePreLegal,
  PRE_LEGAL_DISCLOSURE,
} from "./disclosures.ts";
import {
  detectAccountEscalation,
  intentEscalation,
  escalationMessage,
  ESCALATION_INTENTS,
  type EscalationDecision,
} from "./specialHandling.ts";
import { buildHandoffPackage, type HandoffPackage } from "./handoff.ts";
import { audit } from "./audit.ts";
import { classify, type NLUResult } from "./llm/nlu.ts";
import { render, type Directive } from "./llm/nlg.ts";
import { validateOutput, buildAuthorized, type AuthorizedSet } from "./validator.ts";
import { CONFIG } from "./config.ts";

// The deterministic controller (design §3/§4). Owns the per-turn lifecycle:
// NLU → policy gate → state machine → engine/disclosure → directive → NLG →
// Output Validator → persist + audit. The LLM never drives a transition or a number.

export interface TurnResult {
  reply: string;
  stage: FsmState;
  handoff?: HandoffPackage;
  resolved?: boolean;
}

const STATE_ACTIONS: Record<string, string[]> = {
  CONSENT: ["CONSENT_GIVEN"],
  AUTH: ["PROVIDE_AUTH_FIELDS", "ASK_QUESTION"],
  SERVE: [
    "ASK_QUESTION",
    "ACCEPT",
    "REJECT",
    "PROPOSE_AMOUNT",
    "REQUEST_SETTLEMENT",
    "REQUEST_PLAN",
    "CANNOT_PAY_FULL",
    "AGREE_FC",
    "DECLINE_FC",
    "PROVIDE_FC_FIELDS",
    "SKIP_FC",
  ],
};

function allowedActionsFor(state: FsmState): string[] {
  return [...(STATE_ACTIONS[state] ?? []), ...ESCALATION_INTENTS, "UNCLEAR"];
}

/** Opening turn for a fresh session: greeting + recording-consent notice (§1.1). */
export function openingMessage(): string {
  return (
    "Thank you for contacting Meridian Recovery Services. " +
    RECORDING_CONSENT +
    " How can I help you today?"
  );
}

export async function startSession(sessionId: string): Promise<void> {
  await store.createSession(sessionId);
  await store.appendMessage(sessionId, "assistant", openingMessage());
  await audit(sessionId, "DISCLOSURE_GIVEN", {
    detail: { kind: "recording_consent_notice" },
    fsmStateAtEvent: "CONSENT",
  });
}

// --- NLG render + Output Validator backstop (design §13) -----------------

async function say(
  sessionId: string,
  directive: Directive,
  transcript: ChatMessage[],
  fsmState: FsmState,
  accountRef: string | null,
): Promise<string> {
  let text = await render(directive, transcript);
  if (directive.authorized && !directive.verbatim) {
    const result = validateOutput(text, directive.authorized);
    if (!result.ok) {
      // Backstop fired: drop the model text, use the safe deterministic fallback.
      await audit(sessionId, "OUTPUT_BLOCKED", {
        accountRef,
        detail: { offending: result.offending, intent: directive.intent },
        reason: "unauthorized token in model output; substituted safe fallback",
        fsmStateAtEvent: fsmState,
      });
      text = directive.seedText;
    }
  }
  return text;
}

// --- Helpers to describe offers as directives ----------------------------

function settlementDirective(account: Account, offer: Offer): Directive {
  const pct = (offer.discountBps ?? 0) / 100;
  const amount = formatCents(offer.amountCents ?? 0);
  const balance = formatCents(account.balanceCents);
  const seedText =
    offer.reason.includes("countered")
      ? `The most I'm able to settle this for is ${amount} — that's ${pct}% off the ${balance} balance, which is the best available on this account. Would you like to move forward with that?`
      : `Your balance in full is ${balance}. I can offer to settle the account for ${amount}, a ${pct}% reduction. Would that work for you?`;
  return {
    intent: "PRESENT_OFFER",
    seedText,
    facts: { balance, settlement: amount, discountPct: pct },
    authorized: buildAuthorized({
      amountsCents: [account.balanceCents, offer.amountCents ?? 0],
      percents: [pct],
    }),
  };
}

function planDirective(account: Account, offer: Offer, intro?: string): Directive {
  const months = offer.months ?? offer.schedule?.length ?? 0;
  const monthly = formatCents(offer.monthlyCents ?? offer.schedule?.[0] ?? 0);
  const finalCents = offer.schedule?.[offer.schedule.length - 1] ?? offer.monthlyCents ?? 0;
  const finalPay = formatCents(finalCents);
  const balance = formatCents(account.balanceCents);
  const lead = intro ? `${intro} ` : "";
  const seedText =
    months <= 1
      ? `${lead}We can arrange a single payment of ${monthly}.`
      : `${lead}We can set up ${months} monthly payments of ${monthly}, with a final payment of ${finalPay}, which fully resolves the ${balance} balance. Does that work for you?`;
  const amounts = new Set<number>([account.balanceCents]);
  (offer.schedule ?? []).forEach((c) => amounts.add(c));
  if (offer.monthlyCents) amounts.add(offer.monthlyCents);
  return {
    intent: "PRESENT_OFFER",
    seedText,
    facts: { balance, monthly, finalPayment: finalPay, months },
    authorized: buildAuthorized({
      amountsCents: [...amounts],
      counts: [months],
    }),
  };
}

function confirmDirective(account: Account, offer: Offer): Directive {
  const base =
    offer.kind === "SETTLEMENT"
      ? settlementDirective(account, offer)
      : planDirective(account, offer);
  const amount =
    offer.kind === "SETTLEMENT"
      ? formatCents(offer.amountCents ?? 0)
      : formatCents(offer.monthlyCents ?? offer.schedule?.[0] ?? 0);
  const readback =
    offer.kind === "SETTLEMENT"
      ? `To confirm: a one-time settlement payment of ${amount} resolves the account in full. Shall I lock this in? Please reply yes to confirm.`
      : `To confirm: ${offer.months ?? offer.schedule?.length} monthly payments starting at ${amount}. Shall I lock this in? Please reply yes to confirm.`;
  return {
    intent: "CONFIRM_TERMS",
    seedText: readback,
    facts: base.facts,
    authorized: base.authorized,
  };
}

function plainDirective(intent: string, text: string): Directive {
  // No figures → empty authorized set; the validator only blocks stray numbers.
  return { intent, seedText: text, authorized: buildAuthorized({}) };
}

// --- The turn ------------------------------------------------------------

export async function processTurn(
  sessionId: string,
  userText: string,
): Promise<TurnResult> {
  let session = await store.getSession(sessionId);
  if (!session) {
    await startSession(sessionId);
    session = await store.getSession(sessionId);
  }
  const s = session!;

  await store.appendMessage(sessionId, "consumer", userText);
  const transcript = await store.getMessages(sessionId);
  const account = s.authedAccountRef
    ? await store.findAccountByRef(s.authedAccountRef)
    : null;

  // Terminal states: no further negotiation.
  if (s.fsmState === "RESOLVED" || s.fsmState === "ESCALATED") {
    const reply =
      "This conversation has concluded. If you need anything else, please start a new session or contact us through our published channels.";
    await store.appendMessage(sessionId, "assistant", reply);
    return { reply, stage: s.fsmState, resolved: s.fsmState === "RESOLVED" };
  }

  // NLU classification, scoped to the current state's valid actions.
  const offerOnTable = s.negotiation?.currentOffer
    ? describeOffer(s.negotiation.currentOffer)
    : undefined;
  // During verification, tell the NLU which factor we just asked for so a bare
  // value ("4821") maps to the right slot.
  const authExpecting =
    s.fsmState === "AUTH"
      ? (AUTH_PROMPTS[nextMissingAuth(s.authFields ?? {}) ?? "accountRef"])
      : s.fsmState === "CONSENT"
        ? "account reference number (and any other details they volunteer)"
        : undefined;
  const nlu = await classify({
    transcript,
    latestMessage: userText,
    fsmState: s.fsmState,
    allowedActions: allowedActionsFor(s.fsmState),
    offerOnTable,
    authExpecting,
  });

  // Escalation intents take precedence over everything (any state).
  if (ESCALATION_INTENTS.has(nlu.action)) {
    return finishEscalation(
      s,
      account,
      intentEscalation(nlu.action),
      transcript,
      /* miniMirandaFirst */ false,
    );
  }

  switch (s.fsmState) {
    case "CONSENT":
      return handleConsent(s, nlu, transcript);
    case "AUTH":
      return handleAuth(s, nlu, transcript);
    case "SERVE":
      return handleServe(s, account!, nlu, transcript);
    default:
      return { reply: openingMessage(), stage: s.fsmState };
  }
}

function describeOffer(o: Offer): string {
  if (o.kind === "SETTLEMENT")
    return `settlement of ${formatCents(o.amountCents ?? 0)} (${(o.discountBps ?? 0) / 100}% off)`;
  return `payment plan of ${o.months} months at ${formatCents(o.monthlyCents ?? 0)}/mo`;
}

// --- CONSENT -------------------------------------------------------------

async function handleConsent(
  s: SessionRecord,
  nlu: Awaited<ReturnType<typeof classify>>,
  transcript: ChatMessage[],
): Promise<TurnResult> {
  await store.updateSession(s.sessionId, {
    consentAt: new Date().toISOString(),
    fsmState: "AUTH",
  });
  await audit(s.sessionId, "CONSENT_GIVEN", { fsmStateAtEvent: "CONSENT" });
  // The consent message may also carry identity factors (e.g. "yes — MRS-204418
  // Maria Gonzalez 4821 60616"); ingest them so a one-shot login works.
  return advanceAuth({ ...s, fsmState: "AUTH" }, nlu, transcript);
}

// --- AUTH ----------------------------------------------------------------

const AUTH_PROMPTS: Record<keyof AuthFields, string> = {
  accountRef: "your account reference number",
  firstName: "your first name",
  lastName: "your last name",
  last4ssn: "the last 4 digits of your Social Security Number",
  zip: "your ZIP code",
};

// Format guidance used only when a turn carried no usable value (unexpected input),
// so the re-prompt tells the consumer exactly what shape is expected.
const AUTH_HINTS: Record<keyof AuthFields, string> = {
  accountRef: 'your account reference number — it starts with "MRS-"',
  firstName: "your first name",
  lastName: "your last name",
  last4ssn: "just the last 4 digits of your SSN",
  zip: "your 5-digit ZIP code",
};

function nextMissingAuth(f: AuthFields): keyof AuthFields | null {
  const order: (keyof AuthFields)[] = ["accountRef", "firstName", "lastName", "last4ssn", "zip"];
  return order.find((k) => !f[k]) ?? null;
}

// Identity factors are EXTRACTED by the LLM (NLU = the LLM's job). This function
// does NOT do language understanding — it only NORMALIZES + VALIDATES the values
// the LLM already put in slots (strip non-digits, enforce exact lengths, canonical
// MRS pattern, split a full name). Auth itself is an exact DB match, so any
// extraction slip is a safe retry, never a bypass. Normalization also defuses the
// class of LLM glitch where a value gets echoed/doubled.
const onlyDigits = (s: string): string => (s.match(/\d/g) ?? []).join("");

function normalizeAuthFields(
  slots: NonNullable<NLUResult["slots"]["authFields"]> | undefined,
  current: AuthFields,
): AuthFields {
  const f: AuthFields = { ...current };
  const a = slots ?? {};

  // Account ref — canonicalize the LLM's value to "MRS-<digits>".
  if (a.accountRef && !f.accountRef) {
    const m = String(a.accountRef).match(/(\d{3,})/);
    if (m) f.accountRef = `MRS-${m[1]}`;
  }

  // Last-4 SSN — exactly 4 digits (take the last 4 of the LLM's value).
  if (a.last4ssn && !f.last4ssn) {
    const d = onlyDigits(String(a.last4ssn));
    if (d.length >= 4) f.last4ssn = d.slice(-4);
  }

  // ZIP — exactly 5 digits. First defuse the model's occasional value-doubling
  // ("6061660616" -> "60616", a doubled partial "606606" -> "606"); a real
  // 5-digit ZIP is odd-length so it is never falsely un-doubled. Accept ZIP+4
  // (9 digits) by taking the leading five. A partial like "606" is left UNSET so
  // the turn yields no ZIP and we re-prompt — rather than fabricating a 5-digit
  // value that fails the match and silently burns an auth attempt.
  if (a.zip && !f.zip) {
    let d = onlyDigits(String(a.zip));
    const half = d.length / 2;
    if (d.length % 2 === 0 && d.slice(0, half) === d.slice(half)) d = d.slice(0, half);
    if (d.length === 5) f.zip = d;
    else if (d.length === 9) f.zip = d.slice(0, 5);
  }

  // Names — from the LLM slots. Deterministic safety net: if the model didn't
  // split a full name, split a two-word firstName into first + last.
  let fn = a.firstName ? String(a.firstName).trim() : undefined;
  let ln = a.lastName ? String(a.lastName).trim() : undefined;
  if (fn && !ln && /\s/.test(fn)) {
    const parts = fn.split(/\s+/);
    fn = parts[0];
    ln = parts.slice(1).join(" ");
  }
  if (fn && !f.firstName) f.firstName = fn;
  if (ln && !f.lastName) f.lastName = ln;

  return f;
}

async function handleAuth(
  s: SessionRecord,
  nlu: Awaited<ReturnType<typeof classify>>,
  transcript: ChatMessage[],
): Promise<TurnResult> {
  // Pre-auth question → no disclosure; route back to verification.
  if (nlu.action === "ASK_QUESTION") {
    const f = s.authFields ?? {};
    const miss = nextMissingAuth(f);
    const dir = plainDirective(
      "ASK_AUTH_FIELD",
      `I'm not able to share any account details until your identity is verified. Could you provide ${miss ? AUTH_PROMPTS[miss] : "the remaining verification details"}?`,
    );
    const reply = await say(s.sessionId, dir, transcript, "AUTH", null);
    await store.appendMessage(s.sessionId, "assistant", reply);
    return { reply, stage: "AUTH" };
  }

  return advanceAuth(s, nlu, transcript);
}

const ALL_FACTORS: (keyof AuthFields)[] = ["accountRef", "firstName", "lastName", "last4ssn", "zip"];

// Ingests any identity factors the LLM extracted (one, several, or all at once),
// normalizes them deterministically, then either asks for what's still missing or
// runs the 4-factor match.
async function advanceAuth(
  s: SessionRecord,
  nlu: NLUResult,
  transcript: ChatMessage[],
): Promise<TurnResult> {
  const current = s.authFields ?? {};
  const merged = normalizeAuthFields(nlu.slots.authFields, current);
  await store.setAuthFields(s.sessionId, merged);
  const newlyProvided = ALL_FACTORS.filter((k) => !current[k] && merged[k]);
  await audit(s.sessionId, "AUTH_ATTEMPT", {
    detail: { provided: newlyProvided },
    fsmStateAtEvent: "AUTH",
  });

  const miss = nextMissingAuth(merged);
  if (miss) {
    const filled = ALL_FACTORS.filter((k) => merged[k]).length;
    let dir: Directive;
    if (filled === 0) {
      // Fresh start: invite all-at-once.
      dir = plainDirective(
        "ASK_AUTH_FIELD",
        "To verify your identity I'll need four things: your account reference number, your full name, the last 4 digits of your SSN, and your ZIP code. You're welcome to share them all in one message, or one at a time — whichever is easier. Could you start with your account reference number?",
      );
    } else if (newlyProvided.length === 0) {
      // Mid-verification but this turn carried no usable factor — an unexpected
      // reply (typo, partial value, refusal, off-topic). Don't falsely thank the
      // consumer; acknowledge we didn't catch it, re-ask with the expected format,
      // and offer an exit so a stuck consumer isn't trapped in a re-prompt loop.
      dir = plainDirective(
        "ASK_AUTH_FIELD",
        `Sorry — I didn't catch ${AUTH_PROMPTS[miss]} in that. Could you share ${AUTH_HINTS[miss]}? If you'd rather not continue this way, just let me know and I can connect you with a specialist.`,
      );
    } else {
      // Got something new; ask for the next missing field.
      dir = plainDirective("ASK_AUTH_FIELD", `Thank you. Could you also provide ${AUTH_PROMPTS[miss]}?`);
    }
    const reply = await say(s.sessionId, dir, transcript, "AUTH", null);
    await store.appendMessage(s.sessionId, "assistant", reply);
    return { reply, stage: "AUTH" };
  }

  // All four present → attempt the deterministic 4-factor match.
  const account = await store.authenticate({
    accountRef: merged.accountRef!,
    firstName: merged.firstName!,
    lastName: merged.lastName!,
    last4ssn: merged.last4ssn!,
    zip: merged.zip!,
  });

  if (!account) {
    const attempts = s.authAttempts + 1;
    await store.updateSession(s.sessionId, { authAttempts: attempts });
    await audit(s.sessionId, "AUTH_FAILED", {
      detail: { attempt: attempts },
      reason: "four-factor match failed",
      fsmStateAtEvent: "AUTH",
    });
    if (attempts >= CONFIG.auth.maxAttempts) {
      // SOP §1.4 — disclose nothing, not even whether an account exists.
      return finishEscalation(
        { ...s, authAttempts: attempts },
        null,
        {
          escalate: true,
          code: "AUTH_FAILED",
          reason: "Authentication failed after maximum attempts",
          recommendedAction: "Offer manual identity verification / callback.",
        },
        transcript,
        false,
      );
    }
    await store.setAuthFields(s.sessionId, null); // reset and retry
    const dir = plainDirective(
      "ASK_AUTH_FIELD",
      `That information didn't match what we'd need to verify you. Let's try again — you can share all four details together or one at a time, starting with your account reference number. (${CONFIG.auth.maxAttempts - attempts} attempt${CONFIG.auth.maxAttempts - attempts === 1 ? "" : "s"} remaining.)`,
    );
    const reply = await say(s.sessionId, dir, transcript, "AUTH", null);
    await store.appendMessage(s.sessionId, "assistant", reply);
    return { reply, stage: "AUTH" };
  }

  // AUTH SUCCESS.
  await store.updateSession(s.sessionId, { authedAccountRef: account.accountRef });
  await audit(s.sessionId, "AUTH_SUCCESS", {
    accountRef: account.accountRef,
    detail: { factors: ["accountRef", "name", "last4ssn", "zip"] },
    fsmStateAtEvent: "AUTH",
  });

  // POST-AUTH GATE (transient): special-handling flags / non-serviced region.
  const gate = detectAccountEscalation(account);
  if (gate.escalate) {
    // Mini-Miranda only, then a restrained escalation — NO collector statement,
    // NO balance, NO negotiation (design §4/§10).
    return finishEscalation({ ...s, authedAccountRef: account.accountRef }, account, gate, transcript, true);
  }

  // CLEAR → full disclosures, then SERVE. Disclosures are emitted verbatim.
  const portfolio = getPortfolio(account.portfolioId);
  const parts: string[] = [miniMiranda(portfolio)];
  if (shouldRecitePreLegal(account, portfolio)) parts.push(PRE_LEGAL_DISCLOSURE);
  const cs = collectorStatement(account, portfolio);
  parts.push(cs.text);
  const disclosuresText = parts.join("\n\n");

  const neg: NegotiationState = {
    stage: "PIF",
    settlementTierIndex: 0,
    fcStatus: "none",
    offersExtended: [],
  };
  await store.updateSession(s.sessionId, { fsmState: "SERVE", negotiation: neg });
  await audit(s.sessionId, "DISCLOSURE_GIVEN", {
    accountRef: account.accountRef,
    detail: { miniMiranda: true, preLegal: shouldRecitePreLegal(account, portfolio), collectorStatement: true },
    fsmStateAtEvent: "DISCLOSURES",
  });

  await store.appendMessage(s.sessionId, "assistant", disclosuresText);
  return { reply: disclosuresText, stage: "SERVE" };
}

// --- SERVE ---------------------------------------------------------------

async function handleServe(
  s: SessionRecord,
  account: Account,
  nlu: Awaited<ReturnType<typeof classify>>,
  transcript: ChatMessage[],
): Promise<TurnResult> {
  const neg: NegotiationState = s.negotiation ?? {
    stage: "PIF",
    settlementTierIndex: 0,
    fcStatus: "none",
    offersExtended: [],
  };

  // Low-confidence non-escalation → clarify (never act on a guess; design §8).
  if (nlu.confidence < CONFIG.nlu.confidenceThreshold || nlu.action === "UNCLEAR") {
    await audit(s.sessionId, "CLARIFY", {
      accountRef: account.accountRef,
      detail: { action: nlu.action, confidence: nlu.confidence },
      fsmStateAtEvent: "SERVE",
    });
    return reply(s, "SERVE", plainDirective(
      "CLARIFY",
      "I want to make sure I help with the right thing. Are you looking to pay the balance, set up a payment plan, or discuss a settlement?",
    ), transcript, account.accountRef);
  }

  // Confirmation gate: a read-back is pending.
  if (neg.awaitingConfirmation && neg.currentOffer) {
    if (nlu.action === "ACCEPT") {
      return finalize(s, account, neg, transcript);
    }
    // Anything else cancels the lock-in and resumes negotiation.
    neg.awaitingConfirmation = false;
    await store.updateSession(s.sessionId, { negotiation: neg });
    return reply(s, "SERVE", plainDirective(
      "CLARIFY",
      "No problem — we don't have to lock that in. What would work better for you?",
    ), transcript, account.accountRef);
  }

  switch (nlu.action) {
    case "ASK_QUESTION":
      return answerQuestion(s, account, nlu, transcript);

    case "ACCEPT": {
      if (neg.currentOffer) {
        neg.awaitingConfirmation = true;
        await store.updateSession(s.sessionId, { negotiation: neg });
        return reply(s, "SERVE", confirmDirective(account, neg.currentOffer), transcript, account.accountRef);
      }
      return reply(s, "SERVE", plainDirective(
        "CLARIFY",
        "Great — what would you like to set up? I can take the balance in full, a settlement, or a payment plan.",
      ), transcript, account.accountRef);
    }

    case "CANNOT_PAY_FULL":
    case "REQUEST_SETTLEMENT": {
      const offerRes = proactiveSettlementOffer(account, 0);
      const offer: Offer = {
        kind: "SETTLEMENT",
        stage: "SIF",
        amountCents: offerRes.amountCents,
        discountBps: offerRes.discountAppliedBps,
        capUsedBps: offerRes.capBps,
        verifyFunds: offerRes.verifyFunds,
        reason: offerRes.reason,
      } as Offer;
      neg.stage = "SIF";
      neg.settlementTierIndex = 0;
      neg.currentOffer = offer;
      neg.offersExtended.push(offer);
      await store.updateSession(s.sessionId, { negotiation: neg });
      await audit(s.sessionId, "SETTLEMENT_PROPOSED", {
        accountRef: account.accountRef,
        detail: { amountCents: offer.amountCents, discountBps: offer.discountBps, capBps: offerRes.capBps },
        reason: offerRes.reason,
        fsmStateAtEvent: "SERVE",
      });
      return reply(s, "SERVE", settlementDirective(account, offer), transcript, account.accountRef);
    }

    case "PROPOSE_AMOUNT": {
      // A count of payments/months → a plan (handles NLU putting "4 payments"
      // under PROPOSE_AMOUNT instead of REQUEST_PLAN).
      if (nlu.slots.months != null && nlu.slots.amount == null) {
        return proposePlan(s, account, neg, transcript, { months: nlu.slots.months });
      }
      const cents = nlu.slots.amount != null ? dollarsToCents(nlu.slots.amount) : null;
      if (cents == null) {
        const planOnTable = neg.currentOffer?.kind === "INSTALLMENTS";
        return reply(s, "SERVE", plainDirective(
          "CLARIFY",
          planOnTable
            ? "Sure — how many monthly payments would you like, or how much could you manage per month?"
            : "How much were you thinking, and would that be a one-time payment or monthly?",
        ), transcript, account.accountRef);
      }
      if (nlu.slots.cadence === "monthly") {
        return proposePlan(s, account, neg, transcript, { monthlyAmountCents: cents });
      }
      // Lump-sum settlement proposal.
      const res = evaluateSettlement(account, cents);
      const offer: Offer = {
        kind: "SETTLEMENT",
        stage: "SIF",
        amountCents: res.amountCents,
        discountBps: res.discountAppliedBps,
        capUsedBps: res.capBps,
        verifyFunds: res.verifyFunds,
        reason: res.reason,
      } as Offer;
      neg.stage = "SIF";
      neg.currentOffer = offer;
      neg.offersExtended.push(offer);
      await audit(s.sessionId, "SETTLEMENT_PROPOSED", {
        accountRef: account.accountRef,
        detail: { decision: res.decision, amountCents: res.amountCents, discountBps: res.discountAppliedBps, capBps: res.capBps },
        reason: res.reason,
        fsmStateAtEvent: "SERVE",
      });
      if (res.decision === "accept") {
        neg.awaitingConfirmation = true;
        await store.updateSession(s.sessionId, { negotiation: neg });
        return reply(s, "SERVE", confirmDirective(account, offer), transcript, account.accountRef);
      }
      await store.updateSession(s.sessionId, { negotiation: neg });
      return reply(s, "SERVE", settlementDirective(account, offer), transcript, account.accountRef);
    }

    case "REQUEST_PLAN": {
      const opts: { monthlyAmountCents?: number; months?: number } = {};
      if (nlu.slots.months != null) opts.months = nlu.slots.months;
      if (nlu.slots.amount != null && nlu.slots.cadence === "monthly")
        opts.monthlyAmountCents = dollarsToCents(nlu.slots.amount);
      return proposePlan(s, account, neg, transcript, opts);
    }

    case "REJECT": {
      // Advance the settlement ladder; never past the cap (last tier).
      if (neg.stage === "SIF") {
        const p = getPortfolio(account.portfolioId);
        const atFloor = neg.settlementTierIndex >= p.discountLadderBps.length - 1;
        if (!atFloor) {
          const nextIdx = neg.settlementTierIndex + 1;
          const offerRes = proactiveSettlementOffer(account, nextIdx);
          const offer: Offer = {
            kind: "SETTLEMENT",
            stage: "SIF",
            amountCents: offerRes.amountCents,
            discountBps: offerRes.discountAppliedBps,
            capUsedBps: offerRes.capBps,
            verifyFunds: offerRes.verifyFunds,
            reason: offerRes.reason,
          } as Offer;
          neg.settlementTierIndex = nextIdx;
          neg.currentOffer = offer;
          neg.offersExtended.push(offer);
          await store.updateSession(s.sessionId, { negotiation: neg });
          await audit(s.sessionId, "SETTLEMENT_PROPOSED", {
            accountRef: account.accountRef,
            detail: { tier: nextIdx, amountCents: offer.amountCents, discountBps: offer.discountBps, capBps: offerRes.capBps },
            reason: offerRes.reason,
            fsmStateAtEvent: "SERVE",
          });
          return reply(s, "SERVE", settlementDirective(account, offer), transcript, account.accountRef);
        }
        // At the cap floor — offer a payment plan instead.
        return reply(s, "SERVE", plainDirective(
          "CLARIFY",
          "That settlement is the best I'm able to offer on this account. If a lump sum isn't possible, I can set up a monthly payment plan instead — would that help?",
        ), transcript, account.accountRef);
      }
      return reply(s, "SERVE", plainDirective(
        "CLARIFY",
        "Understood. Would a monthly payment plan work better, or would you like to speak with a specialist?",
      ), transcript, account.accountRef);
    }

    case "AGREE_FC": {
      neg.fcStatus = "gathering";
      await store.updateSession(s.sessionId, { negotiation: neg });
      await audit(s.sessionId, "FC_STARTED", { accountRef: account.accountRef, fsmStateAtEvent: "SERVE" });
      return askNextFcQuestion(s, account, transcript);
    }

    case "DECLINE_FC":
    case "SKIP_FC": {
      neg.fcStatus = "declined";
      await store.updateSession(s.sessionId, { negotiation: neg });
      await audit(s.sessionId, "FC_DECLINED", { accountRef: account.accountRef, fsmStateAtEvent: "SERVE" });
      // Fall back to the 6-month cap on the plan that triggered F&C.
      const pending = neg.pendingFcOffer;
      const opts = pending?.monthlyCents
        ? { monthlyAmountCents: pending.monthlyCents }
        : pending?.months
          ? { months: pending.months }
          : {};
      return proposePlan(s, account, neg, transcript, opts, "Not a problem.");
    }

    case "PROVIDE_FC_FIELDS":
      return ingestFc(s, account, neg, nlu, transcript);

    default:
      return reply(s, "SERVE", plainDirective(
        "CLARIFY",
        "I can help you resolve the balance in full, with a settlement, or a payment plan. Which would you like to explore?",
      ), transcript, account.accountRef);
  }
}

// --- SERVE sub-helpers ---------------------------------------------------

async function reply(
  s: SessionRecord,
  stage: FsmState,
  dir: Directive,
  transcript: ChatMessage[],
  accountRef: string | null,
): Promise<TurnResult> {
  const text = await say(s.sessionId, dir, transcript, stage, accountRef);
  await store.appendMessage(s.sessionId, "assistant", text);
  return { reply: text, stage };
}

async function answerQuestion(
  s: SessionRecord,
  account: Account,
  nlu: Awaited<ReturnType<typeof classify>>,
  transcript: ChatMessage[],
): Promise<TurnResult> {
  const p = getPortfolio(account.portfolioId);
  const qt = nlu.slots.questionType ?? "other";
  let dir: Directive;
  switch (qt) {
    case "balance":
    case "payoff": {
      const balance = formatCents(account.balanceCents);
      dir = {
        intent: "ANSWER_QUESTION",
        seedText: `Your current balance in full is ${balance}.`,
        facts: { balance },
        authorized: buildAuthorized({ amountsCents: [account.balanceCents] }),
      };
      break;
    }
    case "creditor":
      dir = plainDirective(
        "ANSWER_QUESTION",
        `Your account is being handled by Meridian Recovery Services on behalf of ${p.clientName}, and the original creditor was ${account.originalCreditor}.`,
      );
      break;
    case "account_status":
      dir = plainDirective(
        "ANSWER_QUESTION",
        "Your account is past due and has been placed with our office for resolution. I'd be glad to help you resolve it today.",
      );
      break;
    default:
      dir = plainDirective(
        "ANSWER_QUESTION",
        "I may not have that specific information here, but I can help you resolve your balance, or connect you with a specialist if you'd prefer.",
      );
  }
  await audit(s.sessionId, "QUESTION_ANSWERED", {
    accountRef: account.accountRef,
    detail: { questionType: qt },
    fsmStateAtEvent: "SERVE",
  });
  return reply(s, "SERVE", dir, transcript, account.accountRef);
}

async function proposePlan(
  s: SessionRecord,
  account: Account,
  neg: NegotiationState,
  transcript: ChatMessage[],
  opts: { monthlyAmountCents?: number; months?: number },
  intro?: string,
): Promise<TurnResult> {
  const hasProfile = neg.fcStatus === "sufficient";
  let res = evaluateInstallments(
    account,
    { rung: "PPA", principalCents: account.balanceCents, ...opts },
    hasProfile,
  );

  // If the consumer already declined F&C, don't offer it again — give the best
  // plan within the 6-month cap (SOP §3.5) instead of looping.
  if (res.decision === "offer_fc" && neg.fcStatus === "declined") {
    res = evaluateInstallments(
      account,
      { rung: "PPA", principalCents: account.balanceCents },
      false,
    );
  }

  if (res.decision === "offer_fc") {
    // Stash the requested plan; offer F&C to unlock a longer term.
    neg.stage = "PPA";
    neg.pendingFcOffer = {
      kind: "INSTALLMENTS",
      stage: "PPA",
      months: res.months,
      monthlyCents: opts.monthlyAmountCents,
      reason: res.reason,
    } as Offer;
    await store.updateSession(s.sessionId, { negotiation: neg });
    await audit(s.sessionId, "PLAN_PROPOSED", {
      accountRef: account.accountRef,
      detail: { decision: "offer_fc", months: res.months, maxMonths: res.maxMonths },
      reason: res.reason,
      fsmStateAtEvent: "SERVE",
    });
    const portfolio = getPortfolio(account.portfolioId);
    return reply(s, "SERVE", plainDirective(
      "ASK_FC_QUESTION",
      `${intro ? intro + " " : ""}A plan that long is something I can look at, but I'd first need to ask a few quick questions about your finances — it takes about a minute and could let me extend the plan up to the maximum allowed for your account. Would that be okay?`,
    ), transcript, account.accountRef);
  }

  const offer: Offer = {
    kind: "INSTALLMENTS",
    stage: "PPA",
    months: res.months,
    monthlyCents: res.monthlyCents,
    schedule: res.schedule,
    verifyFunds: res.verifyFunds,
    reason: res.reason,
  } as Offer;
  neg.stage = "PPA";
  neg.currentOffer = offer;
  neg.offersExtended.push(offer);
  await store.updateSession(s.sessionId, { negotiation: neg });
  await audit(s.sessionId, "PLAN_PROPOSED", {
    accountRef: account.accountRef,
    detail: { decision: res.decision, months: res.months, monthlyCents: res.monthlyCents, maxMonths: res.maxMonths },
    reason: res.reason,
    fsmStateAtEvent: "SERVE",
  });
  return reply(s, "SERVE", planDirective(account, offer, intro), transcript, account.accountRef);
}

const FC_QUESTIONS: Record<string, string> = {
  netMonthlyIncome: "Roughly what is your net monthly income (take-home pay)?",
  housingPayment: "About how much is your monthly rent or mortgage payment?",
  vehiclePayments: "Do you have a monthly car payment? If so, about how much — and if not, just let me know there's none.",
};

async function askNextFcQuestion(
  s: SessionRecord,
  account: Account,
  transcript: ChatMessage[],
): Promise<TurnResult> {
  const profile = (await store.getFinancialProfile(s.sessionId)) ?? { completeness: "incomplete" as const };
  const miss = nextMissingField(profile);
  if (!miss) return resumeAfterFc(s, account, transcript);
  return reply(s, "SERVE", plainDirective("ASK_FC_QUESTION", FC_QUESTIONS[miss]), transcript, account.accountRef);
}

async function ingestFc(
  s: SessionRecord,
  account: Account,
  neg: NegotiationState,
  nlu: Awaited<ReturnType<typeof classify>>,
  transcript: ChatMessage[],
): Promise<TurnResult> {
  const f = nlu.slots.fcFields ?? {};
  const patch: Partial<FinancialProfile> = {};
  if (f.netMonthlyIncome != null) patch.netMonthlyIncomeCents = dollarsToCents(f.netMonthlyIncome);
  if (f.housingPayment != null) patch.housingPaymentCents = dollarsToCents(f.housingPayment);
  if (f.vehiclePayments != null) patch.vehiclePaymentsCents = dollarsToCents(f.vehiclePayments);
  if (f.otherObligations != null) patch.otherObligationsCents = dollarsToCents(f.otherObligations);
  if (f.payCadence) patch.payCadence = f.payCadence;
  if (f.lastPayDate) patch.lastPayDate = f.lastPayDate;
  if (f.hasCheckingAccount != null) patch.hasCheckingAccount = f.hasCheckingAccount;
  if (f.callbackNumber) patch.callbackNumber = f.callbackNumber;

  const existing = (await store.getFinancialProfile(s.sessionId)) ?? { completeness: "incomplete" as const };
  const combined = { ...existing, ...patch };
  patch.completeness = evaluateCompleteness(combined);
  await store.upsertFinancialProfile(s.sessionId, account.accountRef, patch);

  if (patch.completeness === "sufficient") {
    neg.fcStatus = "sufficient";
    await store.updateSession(s.sessionId, { negotiation: neg });
    await audit(s.sessionId, "FC_COMPLETED", { accountRef: account.accountRef, fsmStateAtEvent: "SERVE" });
    return resumeAfterFc(s, account, transcript);
  }
  return askNextFcQuestion(s, account, transcript);
}

async function resumeAfterFc(
  s: SessionRecord,
  account: Account,
  transcript: ChatMessage[],
): Promise<TurnResult> {
  const fresh = await store.getSession(s.sessionId);
  const neg = fresh!.negotiation!;
  const pending = neg.pendingFcOffer;
  const opts = pending?.monthlyCents
    ? { monthlyAmountCents: pending.monthlyCents }
    : pending?.months
      ? { months: pending.months }
      : {};
  return proposePlan(fresh!, account, neg, transcript, opts, "Thank you — that's all I needed.");
}

async function finalize(
  s: SessionRecord,
  account: Account,
  neg: NegotiationState,
  transcript: ChatMessage[],
): Promise<TurnResult> {
  const offer = neg.currentOffer!;
  const isSettlement = offer.kind === "SETTLEMENT";
  const totalCents = isSettlement
    ? offer.amountCents ?? 0
    : (offer.schedule ?? []).reduce((a, b) => a + b, 0) || account.balanceCents;

  await store.saveResolution({
    sessionId: s.sessionId,
    accountRef: account.accountRef,
    type: isSettlement ? "SIF" : offer.stage,
    amountCents: totalCents,
    discountBps: offer.discountBps ?? 0,
    months: offer.months ?? null,
    schedule: offer.schedule ?? null,
    verifyFunds: !!offer.verifyFunds,
  });
  await store.updateSession(s.sessionId, { fsmState: "RESOLVED", negotiation: { ...neg, awaitingConfirmation: false } });
  await audit(s.sessionId, "OFFER_ACCEPTED", {
    accountRef: account.accountRef,
    detail: {
      type: isSettlement ? "SIF" : offer.stage,
      amountCents: totalCents,
      discountBps: offer.discountBps ?? 0,
      months: offer.months,
    },
    reason: "consumer confirmed terms",
    fsmStateAtEvent: "SERVE",
  });

  const summary = isSettlement
    ? `a one-time settlement payment of ${formatCents(offer.amountCents ?? 0)}`
    : `${offer.months} monthly payments of ${formatCents(offer.monthlyCents ?? 0)}`;
  const dir: Directive = {
    intent: "CONFIRM_TERMS",
    seedText: `You're all set — I've recorded ${summary}. You'll receive the payment-authorization details to finalize. Is there anything else I can help with today?`,
    facts: { summary },
    authorized: buildAuthorized({
      amountsCents: isSettlement
        ? [offer.amountCents ?? 0]
        : [offer.monthlyCents ?? 0, ...(offer.schedule ?? [])],
      counts: offer.months ? [offer.months] : [],
    }),
  };
  const text = await say(s.sessionId, dir, transcript, "RESOLVED", account.accountRef);
  await store.appendMessage(s.sessionId, "assistant", text);
  return { reply: text, stage: "RESOLVED", resolved: true };
}

// --- Escalation ----------------------------------------------------------

async function finishEscalation(
  s: SessionRecord,
  account: Account | null,
  decision: EscalationDecision,
  transcript: ChatMessage[],
  miniMirandaFirst: boolean,
): Promise<TurnResult> {
  await store.updateSession(s.sessionId, { fsmState: "ESCALATED" });
  await audit(s.sessionId, "ESCALATED", {
    accountRef: account?.accountRef ?? null,
    detail: { code: decision.code, recommendedAction: decision.recommendedAction },
    reason: decision.reason,
    fsmStateAtEvent: s.fsmState,
  });

  const auditTrail = await store.getAudit(s.sessionId);
  const profile = account ? await store.getFinancialProfile(s.sessionId) : null;
  const handoff = buildHandoffPackage({
    reason: decision.reason ?? "escalation",
    code: decision.code,
    recommendedAction: decision.recommendedAction,
    triggeredAt: new Date().toISOString(),
    fsmState: s.fsmState,
    consentAt: s.consentAt,
    transcript,
    audit: auditTrail,
    account,
    negotiation: s.negotiation,
    financialProfile: profile,
  });

  const authed = !!account;
  let body = escalationMessage(decision, authed);
  // Post-auth gate hit: lead with the Mini-Miranda (required), nothing else.
  if (miniMirandaFirst) body = `${MINI_MIRANDA}\n\n${body}`;

  await store.appendMessage(s.sessionId, "assistant", body);
  return { reply: body, stage: "ESCALATED", handoff };
}
