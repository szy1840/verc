# Verc — Meridian Recovery Compliant Collections Chatbot · Design

> Founding Engineer Collaboration Day project design.
> Priorities (in order): **Compliance & accuracy (never hallucinate) > Client outcomes (minimize delinquency / maximize recovery) > Experience for a stressed consumer > Speed of iteration.**
>
> Companion files: `collections-reference-pack.md` (the SOP — ground truth), `project-brief.md` (the brief).

---

## 1. What this is

A chatbot on the consumer-facing website of a third-party collections agency (Meridian Recovery Services). After it **takes recording consent and then authenticates the consumer**, it answers basic account questions and negotiates a settlement or payment plan **strictly within the hard ceilings configured for the account's portfolio**; it **escalates to a human** for accounts that can't be self-serviced or whenever the consumer asks.

**North star:** maximize *compliant* recovery without a human in the loop.
**Hard constraint:** the bot **never invents** an amount, date, discount, or policy. With no grounded answer, it says so or escalates.

---

## 2. Core principle: the LLM *speaks*; deterministic code *computes and decides*

This is the foundation of the whole design and the root defense against hallucination and out-of-bounds promises.

| Concern | Owner | Why |
|---|---|---|
| Natural-language understanding, empathetic phrasing | **LLM** | What the LLM is good at |
| Auth status, which conversation state we're in, state transitions | **State machine (deterministic)** | Safety/compliance boundary — not left to the model's goodwill |
| Discount caps, plan-length caps, settlement/plan math | **Policy engine (deterministic)** | One out-of-bounds promise is real legal & financial liability |
| Special-handling flags → forced escalation | **Policy engine (deterministic)** | BKY/DSP/CDP etc. must stop collection, never negotiate |
| Any disclosed number / date / policy text | **From account data + SOP, injected by code** | The LLM relays validated values; it does not generate them |

All concrete values come from exactly three sources, never from the model: (1) mock account data (balance, creditors), (2) policy-engine computation (settlement/plan, within caps), (3) SOP verbatim scripts (disclosures). The LLM receives **already-validated structured results** and only phrases them.

---

## 3. Overall architecture

### Core decision: LLM placement — orchestrator-driven (not agentic tool-calling)
A deterministic orchestrator (state machine + policy gate) **fully owns the conversation flow**. The LLM is confined to **two narrow jobs**:

1. **Understanding (NLU)** — turn the consumer's message into a structured `{action, slots, confidence}` object (e.g. *"I can only do $200 a month"* → `{action: PROPOSE_AMOUNT, slots: {amount: 200, cadence: 'monthly'}}`). Structured output. Full schema in §12.
2. **Speaking (NLG)** — the orchestrator decides **what** to say (which disclosure, which engine-computed offer); the LLM only phrases it empathetically.

**What the LLM deliberately does NOT decide:** state transitions, authentication status, eligibility, any amount / date / discount / term, and any verbatim disclosure. Verbatim disclosures are emitted as exact strings by code — the LLM doesn't even render them. All numbers are computed by the engine and injected for the LLM to relay.

**Why orchestrator-driven over agentic:** this domain rewards predictability and auditability over flexibility. The LLM has no mechanism to act out of bounds — it produces no numbers, controls no state, never touches verbatim text. Anti-hallucination shifts from "constrained by the prompt" to "structurally impossible." Accepted cost: more code, less flexibility.

### The 6 layers
```
1. Chat UI            Next.js (App Router) + shadcn/ui, streaming
        │  POST /api/chat (message + sessionId)
2. Orchestrator API   Deterministic controller (state machine + Policy Gate).
        │             Per turn: decides which engine to call, what to say,
        │             and what (if anything) to expose to the LLM.
        ├──→ 3. LLM layer (AI SDK / Claude via AI Gateway): NLU + NLG only, constrained
        ├──→ 4. Deterministic core (the "truth" layer):
        │        · Auth Verifier             (4-factor match)
        │        · Negotiation Engine        (limits + hierarchy + ladder + SIF/PPA math)
        │        · Disclosures               (verbatim scripts + templates)
        │        · Special-Handling Rules    (flags + non-serviced regions → escalate)
        │        · Account Store             (mock seed)
        ├──→ 5. Output Validator: outbound number/policy check (backstop)
        └──→ 6. Audit Log: every decision + reason (cross-cutting)

   Data: Neon Postgres — Account/Portfolio (read-only seed) · Session/Audit/FinancialProfile/Resolution (mutable)
```

### Tech stack
- **Framework:** Next.js (App Router) on Vercel — Fluid Compute, Node runtime.
- **AI:** Vercel AI SDK via AI Gateway calling Claude; structured output (NLU) + streaming (NLG).
- **UI:** shadcn/ui + Tailwind — clean, responsive, friendly to a stressed consumer.
- **Storage:** Neon Postgres (§7). **Auth:** 4-factor identity match (no account/password login).

### Invariants
- **One-way data flow for facts.** Numbers flow only `Account Store / Engine → injected → LLM relays`. Never `LLM → number`.
- **Stateless functions, external session.** Vercel functions are stateless; conversation state lives in Postgres, keyed by `sessionId`.
- **Fixed per-turn lifecycle:** `receive message → NLU extract → Policy Gate (auth state / flags) → state machine picks action → call engine / fetch disclosure → assemble directive → LLM renders → Output Validator → return + write audit`.

---

## 4. Conversation state machine (the compliance boundary, in code)

The state machine is deterministic; **the LLM never drives transitions**. In each state the LLM is given only the actions/prompts valid for that state.

```
[START]
   │  give the recording-consent notice immediately
   ▼
[CONSENT]  — consumer continues = consent — ▶ record consent timestamp
   ▼
[AUTH]  match account ref + first & last name + last4 SSN + ZIP  (§5)
   │     ├─ success ─────────────────────────────────▶ [POST-AUTH GATE]
   │     └─ fail (≤3 attempts) → retry; 3rd failure ──▶ [ESCALATED]
   │                                                    (disclose nothing, not even existence)
   ▼
[POST-AUTH GATE]  check special-handling flags + non-serviced region (§10)
   │     ├─ HIT  → Mini-Miranda only (+ restrained escalation message) ──▶ [ESCALATED]
   │     │         (NO collector statement, NO balance disclosed, NO negotiation)
   │     └─ CLEAR ▼
[DISCLOSURES]  full sequence, in SOP order (§6):
   │  1. verbatim Mini-Miranda
   │  2. pre-legal disclosure (pre-legal portfolios only)
   │  3. collector statement (on behalf of [client] re [original creditor], balance, receiveDate)
   ▼
[SERVE]  answer basic questions + negotiate
   │  hierarchy (§3.2): PIF/BIF → BIF installments (2–4) → SIF → SIF installments → PPA
   │  all offers computed by the engine within portfolio caps
   │     ├─ deal reached ──▶ [RESOLVED] (record resolution)
   │     └─ consumer asks for human / can't self-serve ──▶ [ESCALATED]
   ▼
[RESOLVED] / [ESCALATED]   (terminal; produce audit summary)
```

**Key rules in code:**
- Before `AUTH`, the orchestrator exposes **no account detail** to the LLM; even "how much do I owe?" only routes to authentication.
- 3 failed auth attempts → disclose nothing (not even whether an account exists) → handoff.
- **Right after auth (the post-auth gate, before any account disclosure beyond the Mini-Miranda)**, run the special-handling + non-serviced-region check; on a hit, give only the Mini-Miranda + a restrained escalation message and escalate — **no collector statement, no balance, no negotiation**. Only a clear gate proceeds to full disclosures. See §10. (The gate is a transient transition executed on auth success, not a persisted `fsmState`.)

---

## 5. Authentication & Consent

> SOP §1 is ground truth; where the brief's wording is looser, the SOP wins.

**Channel classification.** This bot is the SOP's **"Digital self-service (chatbot / payment portal)"** channel — *not* the phone Inbound/Outbound patterns. The phone "any one of (DOB / last-4 SSN / address)" rule does **not** apply.

**Authentication = four factors (all required).** Per SOP §1.3 digital self-service: `account reference + name (first + last) + last 4 of SSN + ZIP`, matched to the account record.
- Rationale: this channel discloses balances/terms with **no human in the loop**, so it's stricter than the phone "one identifier" rule. We do not weaken it to a 3-of-1 choice.
- The brief said only "last name"; the SOP says "first and last name" — we use **first + last name**.
- *Four factors* (name counts as one): account reference · name · last-4 SSN · ZIP.
- **Soft ID** (SOP §1.2 — confirm the right consumer by name before revealing it's a debt-collection matter) is satisfied by the name match inside these factors; no separate step needed.

**Collection method = conversational / progressive (UX choice, not a compliance change).** The bot asks for the factors **one at a time** (account ref → name → last-4 SSN → ZIP) with clear feedback, rather than one large form. We separate *how many factors are required* (compliance → 4) from *how we collect them* (UX → our choice). It never asks the consumer to paste full identifiers in one go.

**Failure handling.** Max **3** attempts. On final failure: disclose nothing — not even whether an account exists (SOP §1.4) — and offer a human handoff / callback. Wrong-party contact → apologize and end.

**Recording consent first.** The recording-consent notice (SOP §1.1) is given before any questions, including before authentication.

**Audit.** Record *how* the consumer was verified (which factors matched) and the auth outcome (SOP §1.3).

---

## 6. Disclosures & FSM sequencing

> All required disclosures are emitted **verbatim / from templates by deterministic code — never LLM-generated**. Source: SOP §1.1, §2.
>
> This is the **clear** path. If the post-auth special-handling gate (§10) fires, the bot gives **only the Mini-Miranda** plus a restrained escalation message and escalates — the full sequence below (notably the balance-bearing collector statement) is **skipped**.

Sequence after a clear gate (DISCLOSURES state), in SOP order:
1. **Mini-Miranda, verbatim** (§2.1). Use `portfolio.miniMirandaVariant` if set, else the standard string.
2. **Pre-legal disclosure** (§2.4) — **only if** `portfolio.isPreLegal` (P-300). **Suppression rule:** not recited if a prior arrangement was breached or for an NSF payment. Modeled with two optional account fields `priorArrangementBreached` / `nsfPayment` (default false) so the rule is demonstrable.
3. **Collector statement** (§2.3) — template with slots: on behalf of [client / current creditor], re [original creditor] account, placed as of [receiveDate], balance [balanceCents]. **First appearance of an amount and a date; both injected from the account record, not generated** → hits anti-hallucination layer 1.
4. Closing prompt → transition to `SERVE`.

(The recording-consent notice is given earlier, in CONSENT, before any questions — SOP §1.1.)

---

## 7. Data layer

> **Storage = Neon Postgres** (Vercel-native). Connection string in `.env.local` as `DATABASE_URL` (gitignored). All access goes through a small `Store` interface.

**Why Neon (not in-memory/JSON):** serverless functions aren't guaranteed a warm in-memory instance across requests, so session state can't live in process once deployed. Postgres also gives a **persistent, queryable audit trail** — the strongest artifact for "prove it's compliant."

**Money & rates are integers:** amounts in **cents**, discounts in **basis points (bps)** — zero floating point.

### Schema
```
Portfolio (read-only config)
  portfolioId PK            // P-100 / P-200 / P-300
  clientName, type
  maxDiscountBps int        // 3500 = 35%
  maxPlanMonths int
  isPreLegal bool
  discountLadderBps int[]   // [1500, 2500, 3500]
  miniMirandaVariant string?

Account (read-only seed)
  accountRef PK
  firstName, lastName, last4SSN, zip
  portfolioId FK
  originalCreditor, currentCreditor
  balanceCents int
  receiveDate date          // collector statement (§6)
  flags string[]            // BKY/DSP/VOD/FRA/CDP/DEC/MIL/...
  stateCode                 // compliance + non-serviced regions (§10)

Session (mutable)
  sessionId PK
  fsmState                  // CONSENT/AUTH/DISCLOSURES/SERVE/RESOLVED/ESCALATED
                            // (POST-AUTH GATE is a transient transition, not a persisted state)
  consentAt ts?
  authAttempts int
  authedAccountRef string?  // null until authenticated → enforces "no disclosure of existence"
  negotiation jsonb         // {stage, settlementTierIndex, fcStatus, offersExtended[]}
  createdAt, updatedAt ts

FinancialProfile (mutable; one per session) — F&C, see §9
  id PK, sessionId FK, accountRef string?
  netMonthlyIncomeCents, housingPaymentCents, vehiclePaymentsCents, otherObligationsCents int?
  payCadence string?, lastPayDate date?
  hasCheckingAccount bool?  // ACH — STUBBED
  callbackNumber string?    // + call-back consent — STUBBED
  completeness string       // incomplete | sufficient
  createdAt, updatedAt ts
  // All fields SELF-REPORTED via conversation; no proof/verification required (§9).

AuditEvent (append-only) — compliance evidence chain
  id PK, ts, sessionId FK, accountRef string?
  event                     // CONSENT_GIVEN/AUTH_ATTEMPT/AUTH_SUCCESS/AUTH_FAILED/
                            // DISCLOSURE_GIVEN/SETTLEMENT_PROPOSED/PLAN_PROPOSED/OFFER_ACCEPTED/
                            // FC_STARTED/FC_COMPLETED/FC_DECLINED/FC_ABANDONED/
                            // ESCALATED/OUTPUT_BLOCKED/CLARIFY/...
  detail jsonb              // {amountCents, discountBps, cap, reason, ...}
  fsmStateAtEvent

Resolution (terminal snapshot — independent table, queryable outcome of record)
  sessionId, accountRef, type(SIF/PPA/PIF...), amountCents, discountBps,
  months?, schedule[], verifyFunds bool, agreedAt ts
```

**Notes:**
- `authedAccountRef` is null pre-auth → the schema itself enforces "disclose nothing, not even existence, before auth" (SOP §1.4).
- `AuditEvent` is append-only; production can add a hash chain for tamper-evidence.

### Seed & reproducibility
The demo must be reproducible — testing writes data (F&C profiles, sessions, audit), but every demo starts pristine.
- **Account & Portfolio are READ-ONLY at runtime — never mutated.** F&C writes to its own `FinancialProfile` table, so original account data is never polluted.
- **Mutable tables:** `Session`, `FinancialProfile`, `AuditEvent`, `Resolution`.
- A **`reset` script** (npm script / dev-only route) truncates the mutable tables and re-seeds the read-only ones from version-controlled fixtures → one command restores the clean state.

---

## 8. Policy / Negotiation Engine

> The deterministic "truth" layer for all resolution math. The LLM never produces a number; it only classifies intent. Source: SOP §3.

### Sources of truth (SOP vs. our interpretation)
- **SOP §3.3 (verbatim):** portfolio max settlement discount & max plan length. **Hard ceilings.**
- **SOP §3.2 (verbatim):** hierarchy `PIF/BIF → BIF in payments (2–4) → SIF → SIF in payments → PPA`.
- **SOP §3.1 (verbatim):** open with balance in full; verify funds on any payment > $1,500.
- **SOP §3.5 (verbatim):** without a financial profile, an arrangement may resolve the balance over **up to 6 months**.
- **SOP §3.4 (verbatim):** the F&C (Full-and-Complete) financial profile supports **longer/temporary** arrangements.
- **Our interpretation (not single-sentence verbatim):** collecting an F&C profile **unlocks the portfolio's full max plan length** (12/18). Derived from §3.3 + §3.4 + §3.5. **Adopted** (lightweight).

### Portfolio limits (hard ceilings — never exceeded)
| Portfolio | Client / type | Max settlement discount | Max plan length | Discount ladder (tunable) |
|---|---|---|---|---|
| P-100 | Northwind Capital — auto / secured | 35% | 6 months | `[15%, 25%, 35%]` |
| P-200 | Apex Card — credit card | 50% | 12 months | `[20%, 35%, 50%]` |
| P-300 | Harbor Recovery — personal (pre-legal) | 25% | 18 months | `[10%, 18%, 25%]` |

Config-driven; onboarding a new portfolio = adding one row. The engine offers **at or below** the cap, never above.

### Resolution hierarchy & strategy (maximize recovery within the ceiling)
Always open by requesting the **balance in full**; descend a rung only when the consumer can't do the current one:
```
PIF / BIF (full balance, ideally ACH today)
  ↓ can't pay in full
BIF in payments (full balance over 2–4 payments, no discount → still full recovery)
  ↓
SIF (settlement: try small discounts first, do not lead with the cap)
  ↓
SIF in payments (settled amount over multiple payments, per client rules)
  ↓
PPA (temporary payment plan, bounded by plan-length cap)
```
> ⚠️ Two easily-confused rules (kept distinct):
> - **BIF in payments = 2–4 payments** (SOP §3.2; full balance, short, no discount).
> - **"No financial profile → arrangement ≤ 6 months" is the SOP §3.5 rule**, which applies to **PPA** (via `effectiveMaxMonths`) — NOT to BIF in payments.

**Recovery-maximizing detail:** never lead with the max discount. Anchor with a small concession, give the consumer room to say "I can't," then step toward the cap. All concessions are clamped by the portfolio cap. This anchor-and-step logic lives in the orchestrator, not the LLM.

### Negotiation strategy — config-driven discrete discount ladder (chosen)
Each portfolio defines an ordered discount ladder; the **last tier always equals the cap**. The engine offers tier 0 first and advances **only when the consumer rejects**, never indexing past the last tier (structurally cannot exceed the cap).

Example — P-100, $1000 balance, consumer asks "best you can do?": $850 (15% off) → if rejected $750 (25%) → if rejected $650 (35%, floor, never lower).

**Rejected alternatives:** static single offer at cap (leaves money on the table); continuous algorithmic concession (hard to audit "why 27.3%?"); LLM decides discount within a clamp (violates the core principle; non-deterministic; poor audit story).

### Settlement evaluation rule (SIF lump)
```
allowedMinPayment = balance × (1 − cap)            // paying less is forbidden
· Proactive offer (consumer asks "best you can do"):
    offer balance × (1 − tier[i]); advance i on rejection; floor at last tier (= cap).
· Consumer proposes amount X:
    - X ≥ allowedMinPayment → ACCEPT  (within cap → take it; compliant, low-friction)
    - X <  allowedMinPayment → COUNTER at allowedMinPayment, reason "best we can do"
```

### Installment evaluation rule (covers all three installment rungs)
One evaluator over a `principal` and a `maxMonths` bound; the rung sets both:

| Rung (`stage`) | principal | months bound | discount |
|---|---|---|---|
| `BIF_INSTALLMENTS` | full balance | **2–4** | none — full recovery |
| `SIF_INSTALLMENTS` | settled = `balance × (1 − discount)` | 2–4 (per client rules) | per the accepted SIF |
| `PPA` | full balance | `effectiveMaxMonths` | none |

```
effectiveMaxMonths = hasProfile ? portfolio.maxPlanLength : min(portfolio.maxPlanLength, 6)
                     // §3.5 (no profile → ≤6mo) + F&C unlock. PPA only.
                     // BIF/SIF installments use the fixed 2–4 bound, not this.

solveInstallments(principal, requested, maxMonths):   // core solver; the public
                                                      // evaluateInstallments() sets principal +
                                                      // maxMonths per rung, then calls this
  · Consumer proposes monthly Y → monthsNeeded = ceil(principal / Y)
      - monthsNeeded ≤ maxMonths → ACCEPT, build schedule
      - monthsNeeded > maxMonths:
          · PPA AND no profile AND portfolio.maxPlanLength > 6 → offer F&C to unlock a longer term
          · else → COUNTER minimum monthly = ceil(principal / maxMonths)
  · Consumer proposes months M → M ≤ maxMonths ? ACCEPT : COUNTER at maxMonths
```
**BIF in payments keeps the full balance (no discount) → preferred over SIF** in the hierarchy.

### Money math (Naga will inspect this)
- All amounts stored & computed in **integer cents** (no floating point).
- Settlement: `round(balance × (1 − discount))`.
- **Installment schedules ALWAYS sum to exactly the principal — never over- or under-collect.** Two construction cases (the final installment is the remainder either way):
  - Consumer proposes **months M** → `monthly = floor(principal / M)`; **final installment takes the remainder** (≥ monthly). E.g. M=18, principal=$2,675 → $148 ×17 + final $159.
  - Consumer proposes **monthly Y** → pay Y for `⌈principal / Y⌉ − 1` months; **final = principal − Y×(n−1)** (≤ Y). E.g. Y=$150, principal=$2,675 → $150 ×17 + final $125. (Do **not** charge Y × n: $150×18 = $2,700 > $2,675.)
  - Counter "minimum monthly" = `ceil(principal / maxMonths)`; its final installment is the smaller remainder.
- Any single payment **> $1,500** sets a `verify-funds` audit flag (SOP §3.1).

### Pure-function API (deterministic, unit-testable)
```
getPortfolio(portfolioId) → { maxDiscount, maxPlanLength, isPreLegal, discountLadder }
evaluateSettlement(account, proposedAmount?)        // no hasProfile: settlement cap is independent of F&C (§9)
  → { decision: accept|counter|reject, amount, discountApplied, cap, reason }
evaluateInstallments(account, { rung, principalCents, monthlyAmount? | months? }, hasProfile)
  → { decision, months, monthly, schedule[], maxMonths, reason }
  // rung ∈ BIF_INSTALLMENTS | SIF_INSTALLMENTS | PPA; maxMonths per rung (2–4 or effectiveMaxMonths)
nextNegotiationStep(negotiationState, consumerAction, account) → next offer + audit reason
```
Every return carries `{cap, reason}` → fed straight into the audit log.

### Negotiation state (source of truth = orchestrator, not LLM memory)
```
NegotiationState {
  stage: PIF | BIF_INSTALLMENTS | SIF | SIF_INSTALLMENTS | PPA
  settlementTierIndex: number
  fcStatus: none | gathering | sufficient | declined   // F&C sub-mode within SERVE
                                                       // ("GATHERING_FC" = fcStatus 'gathering')
  offersExtended: Offer[]        // audit trail
}
// hasProfile (used by the engine) is derived: hasProfile = (fcStatus === 'sufficient').
// F&C runs as a sub-mode of the SERVE state — it is NOT a separate top-level FSM state.
```
What was offered and which tier we're on is held in deterministic code; the LLM only interprets the *latest* message. The system never drifts even if the LLM "forgets."

### Confidence routing & confirmation gate
NLU returns `{ action, slots, confidence }`. The orchestrator routes deterministically — it never acts on a guess:
1. `confidence ≥ threshold` → proceed to the engine.
2. `confidence < threshold` or ambiguous → ask a **clarifying question** presenting the candidate options.
3. **High-stakes actions** (accept an offer, finalize, escalate, any extracted money amount) require a **confirmation gate regardless of confidence**: read terms back and require an explicit "yes". This doubles as SOP §3.6 compliance ("explicit approval: arrangement type, amount(s), date(s)" + read-back) **and** guards slot-extraction errors ("$200" vs "$2000").
4. Repeated failure to classify (e.g. 2 clarification rounds) → **escalate to a human**.

---

## 9. Financial Profile (F&C) flow

> F&C = the bot gathers a financial picture **conversationally** to **unlock longer payment plans** (6 → portfolio max) and size a realistic plan. SOP §3.4–3.5; ethos = "Converse NOT Interrogate." Persisted to the `FinancialProfile` table (§7).

### Where the LLM sits (it gathers & extracts; the engine decides)
| Action | Who |
|---|---|
| Ask the F&C questions empathetically, a few at a time | **LLM (NLG)** — flexible; it's *asking*, not *stating facts* |
| Extract answers into structured `FinancialProfile` slots | **LLM (NLU)** |
| Judge whether the profile is complete → unlock longer terms | **Engine (deterministic)** |
| Compute affordability / size a realistic plan | **Engine (deterministic)** |
| The actual offer after F&C | **Engine + Output Validator** (unchanged) |

The bot never says "this unlocks 12 months" itself; the engine sets `hasFinancialProfile = true`, raising `effectiveMaxMonths`, then the offer is re-evaluated and validated.

### End-to-end flow (example: P-300, balance $2,675, cap 18 months)
```
1. Consumer wants a long plan, e.g. "I can only do $150/month"
2. Engine: monthsNeeded = ceil(2675/150) = 18; no profile → effectiveMaxMonths = min(18,6) = 6
     18 > 6 AND portfolio cap (18) > 6  →  trigger F&C offer
3. Bot asks consent for F&C: "To set up a plan longer than 6 months I need to ask
     a few quick financial questions — about a minute. Is that okay?"
4. Consent → fcStatus = 'gathering' (a sub-mode of SERVE): LLM asks conversationally,
     extracting into FinancialProfile (persisted)
5. Completeness check passes → fcStatus = 'sufficient' (hasProfile = true) → effectiveMaxMonths = 18
6. Re-evaluate: monthsNeeded 18 ≤ 18 ✓
     → honor $150/mo: 17 payments of $150 + a final payment of $125 = $2,675 exactly
       (NOT $150 × 18 = $2,700 — that would over-collect $25)
7. Confirmation gate: read back "$150/mo for 17 months, then a final $125 — total $2,675"
     → explicit yes → RESOLVED
8. Audit: FC_STARTED / FC_COMPLETED / PLAN_PROPOSED(months=18) / OFFER_ACCEPTED
```
If the consumer **declines** F&C → stays at the 6-month cap → engine counters with minimum monthly = `ceil(2675/6) = $446/mo` (schedule: 5 × $446 + final $445 = $2,675).

### F&C is always optional — graceful skip / decline / abandon
"Converse NOT Interrogate" → never pressure, always offer a clean exit:
- **Declines at consent** → don't start gathering; revert to the 6-month cap and present the best plan there (and other options). No repeated asking.
- **Abandons mid-gathering** ("skip this" / changes topic / asks for the plan now) → stop collecting, keep `completeness = incomplete` (longer terms stay locked), persist what was captured, fall back to 6 months. Conversation never lost.
- **Refuses a single question** → optional field → skip; required field → explain plainly it's needed to unlock a longer plan and offer the 6-month option instead; respect the choice.
- **Escalation intent during F&C** → escalation wins (§10): abandon F&C and escalate.
- Declined/abandoned F&C is logged (`FC_DECLINED` / `FC_ABANDONED`).

### Decisions
1. **Collect a sufficient subset, not all ~20 SOP questions:** net monthly income, pay cadence / last pay date, housing payment, vehicle payment, other major obligations, checking-account y/n, callback number. Humane, fast, less PII.
2. **Completeness is a deterministic gate:** `sufficient` requires at least net monthly income + housing payment (+ vehicle payment or confirmation of none).
3. **Affordability is a soft suggestion, not a hard gate:** engine may compute `disposable = income − housing − vehicle − other` to size/sanity-check a monthly, but never *rejects* a deal on it (collections maximize recovery). Optional enhancement.
4. **F&C affects plan length & sizing only — not the settlement discount cap.**
5. **Persisted to the `FinancialProfile` table**, keyed by session (and accountRef once authenticated).

### What is STUBBED
- **Self-reported only — no proof required.** We ask and take answers at face value; we do **not** request or verify documentation (no pay stubs, bank statements, income verification).
- **ACH / bank details** — captured as a flag only; no real payment.
- **Callback number + consent** — recorded only; no telephony.
- **PII note:** sensitive financial PII; production needs encryption at rest + a retention/deletion policy. For the demo it's plain Postgres, clearly marked stubbed.

---

## 10. Special handling & escalation

> "Escalate — do not negotiate." Source: SOP §4. Two independent trigger sources, both covered.

### Source 1 — Account-borne flags / non-serviced region (deterministic; checked right after auth)
The account record carries flags (`BKY/DSP/VOD/FRA/CDP/DEC/MIL/HRA/APP/MOS/DBM/ATTY`). The FSM checks them after successful auth, **before** SERVE:
```
auth success → detect flag / non-serviced region (the post-auth gate, §4)
  → Mini-Miranda (required) + restrained escalation message → place on hold → ESCALATED
  (NO collector statement, NO balance disclosed, NO negotiation)
```
This is "authenticate if needed, then hold + escalate" (SOP §4.1) — **no offer, no quote, no balance**. The flag/region is detected *first* (from account data), so the balance-bearing collector statement is never reached. CDP (cease & desist; brief alias `CNA`), DEC (deceased), and non-serviced regions get more restrained/neutral wording.

**Regions not serviced (SOP §5.6) — handled like a flag.** If the account's `stateCode` is in the non-serviced set — Armed Forces `AA/AE/AP`, Guam `GU`, Puerto Rico `PR`, U.S. Virgin Islands `VI`, Northern Mariana Islands `MP`, listed Pacific territories — we **do not collect**: after auth, hold and escalate. Checked alongside the flags.

### Source 2 — Conversation-surfaced triggers (NLU; possible in ANY state)
A clean account can become an escalation the moment the consumer speaks. NLU detects escalation intents in any state:
```
DECLARE_BANKRUPTCY / DISPUTE_DEBT / REQUEST_VOD / REPORT_FRAUD /
CEASE_AND_DESIST / REPORT_DECEASED / DECLARE_MILITARY / ATTORNEY_REPRESENTED /
HARDSHIP / CLAIM_PRIOR_RESOLUTION / REPORT_RELOCATION / REQUEST_HUMAN
```
On detection → **immediately short-circuit the negotiation engine**, hold, escalate. The bot must never keep quoting after, e.g., the consumer disputes the debt.

**Intent ↔ SOP §4.1 code (full coverage):** so the conversation-surfaced set matches the account-flag set 1:1.

| NLU intent | SOP §4.1 code |
|---|---|
| DECLARE_BANKRUPTCY | BKY |
| REPORT_DECEASED | DEC |
| DECLARE_MILITARY | MIL |
| REPORT_FRAUD | FRA |
| REQUEST_VOD | VOD |
| DISPUTE_DEBT | DSP |
| CEASE_AND_DESIST | CDP (brief alias CNA) |
| HARDSHIP | HRA |
| CLAIM_PRIOR_RESOLUTION | APP (settled/paid elsewhere) |
| REPORT_RELOCATION | MOS (moved out of state/country) |
| ATTORNEY_REPRESENTED | DBM / ATTY (debt manager or attorney) |
| REQUEST_HUMAN | — (explicit handoff, not a SOP code) |

**`REQUEST_HUMAN` — explicit handoff request.** The brief requires escalating "when the consumer asks." A direct request for a human (any state, including mid-F&C and pre-auth) is always honored. Pre-auth, we hand off without disclosing account details.

**Priority:** escalation intents take precedence over every sub-flow.

### Critical distinction (encoded in the NLU instructions)
- **DISPUTE (must escalate)** = challenges the debt's **validity / accuracy**: "I don't owe this," "that amount is wrong," "I never opened that account."
- **Ordinary negotiation pushback (keep negotiating)** = acknowledges the debt but can't/won't pay full: "that's too expensive, can you lower it," "I can only do $200/month."

They look similar but have opposite compliance consequences. **When validity is genuinely in doubt, err toward escalation.** Don't treat price resistance as a dispute. (SOP §4.2: disputes/VOD are holds; NY treats all dispute types as VOD except fraud — state-specific handling out of scope.)

### Clean handoff — complete context package
Escalation (any state, any trigger) assembles a complete `HandoffPackage` so the human picks up with zero context loss:
```
HandoffPackage {
  reason            // flag code / intent / REQUEST_HUMAN / AUTH_FAILED / ...
  triggeredAt, fsmStateAtEscalation
  authStatus        // authenticated | unauthenticated
  consentRecord
  fullTranscript    // EVERY turn, verbatim, in order
  auditTrail        // every AuditEvent for the session
  // ---- only if authenticated ----
  accountSummary    // accountRef, portfolio, balance, creditors, flags
  negotiationState  // stage, tiers tried, offers, current offer on the table
  financialProfile  // F&C data, if collected
  recommendedAction // e.g. "BKY hold — route to bankruptcy desk"
}
```
**Auth-aware redaction:** if escalation happens **before** auth (auth failed, or pre-auth `REQUEST_HUMAN`), the package contains transcript + reason + audit trail **only — no account details** (never disclosed, not leaked downstream; SOP §1.4).

**Stubbed boundary:** the package is real and complete; the *delivery* to a live agent (chat seat / warm phone transfer) is **stubbed** — the prototype renders/persists the package and shows a "connecting you to a specialist" UI, but there is no real human on the other end.

---

## 11. Mock account store — test data

> Seven scenarios cover every rule path; #8 adds the non-serviced region. Seeded from version-controlled fixtures (§7). Amounts shown in dollars; stored in cents.

### Credential cards (what to type to authenticate)
Auth = four factors: `account ref + name (first+last) + last 4 SSN + ZIP` (§5).

| # | Scenario | Account Ref | Name | last4 SSN | ZIP | Portfolio | Balance | Flags | Expected path |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Happy path** (credit card) | `MRS-204418` | Maria Gonzalez | 4821 | 60616 | P-200 | $4,820.00 | — | auth → disclosures → settle/plan within 50% / 12mo |
| 2 | Negotiable (auto) | `MRS-100937` | James Carter | 7390 | 75201 | P-100 | $11,240.00 | — | close within 35% / 6mo |
| 3 | Negotiable (personal, pre-legal) | `MRS-300256` | Aisha Bello | 1156 | 30307 | P-300 | $2,675.00 | — | extra pre-legal disclosure; 25% / 18mo |
| 4 | Bankruptcy | `MRS-204550` | Robert Kim | 9043 | 98101 | P-200 | $6,310.00 | `BKY` | auth → escalate, never negotiate |
| 5 | Dispute / VOD | `MRS-100712` | Linda Foster | 5567 | 85004 | P-100 | $8,990.00 | `DSP` | stop & escalate |
| 6 | Cease & desist | `MRS-300489` | Daniel Reyes | 3320 | 10025 | P-300 | $1,540.00 | `CDP` | no contact, escalate |
| 7 | **Auth fails** | `MRS-559000` | Alex Turner | 0000 | 00000 | (no match) | — | — | 3 failures → disclose nothing → handoff |
| 8 | Region not serviced | `MRS-300781` | Carmen Diaz | 6624 | 00926 | P-300 | $3,150.00 | — | auth → not serviced (PR) → escalate |

### Supplemental fields (used by the collector statement, §6)
| # | Original creditor | Current creditor / client | receiveDate | State |
|---|---|---|---|---|
| 1 | Summit Bank Visa | Apex Card LLC | 2026-03-12 | IL |
| 2 | Lonestar Auto Finance | Northwind Capital | 2026-02-28 | TX |
| 3 | Cascade Personal Loans | Harbor Recovery | 2026-04-05 | GA |
| 4 | Cobalt Bank MasterCard | Apex Card LLC | 2026-03-30 | WA |
| 5 | Lonestar Auto Finance | Northwind Capital | 2026-02-14 | AZ |
| 6 | Evergreen Lending | Harbor Recovery | 2026-04-22 | NY |
| 8 | Skyline Personal Loans | Harbor Recovery | 2026-05-01 | PR |

**Notes:**
- Scenario 7 is **not an account record** — a "guaranteed-no-match" card demonstrating the failed-auth path (and that we disclose nothing).
- Scenario 8 authenticates but `stateCode = PR` is in the non-serviced set (SOP §5.6) → do-not-collect hold → escalate.
- All balances > $1,500, so any lump sum triggers the §3.1 `verify-funds` flag.
- Scenario 3 (P-300) is the only pre-legal portfolio → demonstrates the pre-legal disclosure.
- **Optional extras** (only if time): `DEC` / `MIL` / `FRA`, one account each.

---

## 12. LLM interface contract

> The precise data contract between orchestrator and LLM. Two call types, run separately for reliability + auditability (up to 2 calls/turn). Many turns skip NLG (verbatim disclosures / templated offers are emitted by code).

### NLU call — message → structured classification (no consumer-facing text)
```
NLUResult {
  action      // enum below; constrained to the current state's valid subset
  slots {
    amount?        number        // dollars as stated; orchestrator converts to cents
    cadence?       'lump' | 'monthly'
    months?        integer
    questionType?  'balance' | 'payoff' | 'creditor' | 'account_status' | 'other'
    authFields?    { accountRef?, firstName?, lastName?, last4ssn?, zip? }
    fcFields?      { netMonthlyIncome?, payCadence?, lastPayDate?, housingPayment?,
                     vehiclePayments?, otherObligations?, hasCheckingAccount?, callbackNumber? }
  }
  confidence  number   // 0..1, drives the §8 routing
  rationale   string   // short; goes to audit/debug
}
```
**action enum** (orchestrator passes only the valid subset per state; escalation intents + `REQUEST_HUMAN` valid in EVERY state):
- Flow: `CONSENT_GIVEN / PROVIDE_AUTH_FIELDS / ASK_QUESTION`
- Negotiation: `ACCEPT / REJECT / PROPOSE_AMOUNT / REQUEST_SETTLEMENT / REQUEST_PLAN / CANNOT_PAY_FULL`
- F&C: `AGREE_FC / DECLINE_FC / PROVIDE_FC_FIELDS / SKIP_FC`
- Escalation (any state): `DECLARE_BANKRUPTCY / DISPUTE_DEBT / REQUEST_VOD / REPORT_FRAUD / CEASE_AND_DESIST / REPORT_DECEASED / DECLARE_MILITARY / ATTORNEY_REPRESENTED / HARDSHIP / CLAIM_PRIOR_RESOLUTION / REPORT_RELOCATION / REQUEST_HUMAN` (1:1 with SOP §4.1 codes — mapping in §10)
- Fallback: `UNCLEAR`

If the returned action isn't in the state's valid subset (and isn't an escalation intent) → treat as `UNCLEAR` → clarify. Amounts: NLU returns dollars as stated; the orchestrator normalizes to cents; the confirmation gate (read-back) guards extraction errors.

### NLG call — directive → empathetic prose
The orchestrator builds the directive; **`facts` IS the Output Validator's authorized-token set** (§13).
```
Directive {
  intent          // ASK_CONSENT / ASK_AUTH_FIELD / GIVE_DISCLOSURE / PRESENT_OFFER /
                  // COUNTER_OFFER / ASK_FC_QUESTION / CONFIRM_TERMS / ESCALATE_MESSAGE /
                  // ANSWER_QUESTION / CLARIFY
  verbatimText?   // if set: output exactly, no paraphrase (disclosures)
  facts {}        // the ONLY numbers/values allowed in the output (= authorized set)
  allowParaphrase // false for verbatim disclosures
  fallbackText    // deterministic safe text if generation/validation fails
}
```
Example: `PRESENT_OFFER`, `facts = {settlementAmount: 650, discountPct: 35, balance: 1000}` → the LLM phrases it; the validator allows only 650 / 35 / 1000.

### System prompts (English; concise role context, no SOP dump)
The SOP is enforced deterministically, so the prompts carry only enough role grounding to be coherent.

**NLU system prompt:**
```
You are the intent classifier for the web chat assistant of Meridian Recovery Services,
a third-party debt-collection agency that helps consumers resolve past-due accounts.
You do NOT talk to the consumer. Given the conversation, the current state, the offer on
the table (if any), and the allowed action labels, output ONLY a JSON object matching the
NLUResult schema.

Rules:
- Pick exactly one action from the allowed set. Escalation intents and REQUEST_HUMAN are
  always allowed.
- Extract relevant values into slots (amounts in dollars as stated).
- CRITICAL: distinguish DISPUTE_DEBT (challenges the debt's validity/accuracy — "I don't
  owe this", "that amount is wrong", "I never opened this account") from ordinary
  negotiation pushback (acknowledges the debt but can't/won't pay full — "that's too much",
  "I can only do $200/month").
- Set confidence in [0,1]. If unsure or ambiguous, use low confidence and/or UNCLEAR.
  Never guess.
- Output JSON only. Never address the consumer.
```

**NLG system prompt:**
```
You are the voice of the web chat assistant for Meridian Recovery Services, a third-party
debt-collection agency. You help consumers resolve past-due accounts in a courteous, calm,
and empathetic way — many people you speak with are stressed about money. Be concise and
human.

ABSOLUTE RULES:
- Use ONLY the values provided in the directive's `facts`. NEVER state, estimate, or invent
  any amount, date, discount, term, balance, or policy that is not in `facts`.
- If `verbatimText` is provided, output it EXACTLY, word for word, with no additions or
  changes.
- Make no promises, threats, or legal statements. Give no legal or financial advice.
- Convey the directive's `intent`. Keep it short.
```

---

## 13. Anti-hallucination guardrails

> The #1 evaluation priority. Defense in depth across three layers; the LLM does NLU + NLG only and never originates a fact.

### Layer 1 — Structural: the LLM cannot originate a fact
- **NLU mode** produces no consumer-facing prose — only a classification — so it has no surface to hallucinate to the consumer.
- **NLG mode** receives a directive with the exact values/sentences, plus a hard instruction to use only those values and never invent amounts/dates/discounts/terms/policy.
- **Verbatim disclosures bypass the LLM entirely** (Mini-Miranda, pre-legal, collector-statement slots — emitted by code, §6).
- **Strongest variant for fact-carrying turns:** highest-stakes messages (offers, confirmations, disclosures) are **code-templated with engine-filled slots**; the LLM only supplies empathetic connective tissue and free-form Q&A phrasing. The LLM cannot move a number.

### Layer 2 — Deterministic enforcement upstream of the LLM
All math, caps, and eligibility are computed by the pure-function engine (§8) **before** the directive is built. The directive can only ever contain compliant values — even a flawless rendering cannot exceed a cap. This is the "resolution math enforced deterministically, not left to the model" guarantee.

### Layer 3 — Output Validator (outbound backstop)
Runs server-side on the NLG output before it reaches the consumer. A backstop, not the primary defense — but it makes the guarantee *demonstrable*.

**Algorithm — grounding / allow-list check:**
1. Assemble an **authorized-token set** for the turn: every value in the directive (offer amount, discount, balance, account ref, dates) + a static whitelist.
2. Extract every currency amount, percentage, bare number, and date from the output (regex + parsing), with **normalization** (`$650.00 == 650`, `35% == 0.35`).
3. Require each extracted token to be in the authorized set.
4. **Any unauthorized token → block.** Drop the text, substitute a deterministic safe fallback ("Let me double-check that — one moment," then re-derive or escalate), and log `OUTPUT_BLOCKED` with the offending token.
5. (Optional) also assert **required** figures are present — guards omission as well as fabrication.

**Streaming tradeoff:** generate-then-validate-then-send for fact-carrying turns (small latency cost, accepted); pure-empathy turns with no figures may stream.

**Known limitations (stated honestly):**
- **Spelled-out numbers** ("six fifty") evade the regex → instruct the LLM to use digits; optionally normalize number words. Documented gap.
- **Non-numeric policy hallucination** (inventing "you have 30 days to dispute") isn't caught by number-matching → keep policy/legal statements as verbatim templates (Layer 1), not LLM prose. The validator owns numbers/dates; Layer 1 owns policy text.
- **False positives** (the real balance legitimately appears) are non-issues — authorized values are in the set.

### No grounded answer → say so or escalate. Never guess.

### How we prove it's compliant
- **Audit trail (§7):** every figure shown is traceable to an engine result + the turn's authorized set; `OUTPUT_BLOCKED` events prove the backstop fired.
- **Tests:** property-based tests that the engine never exceeds caps across fuzzed inputs; validator tests that injected hallucinations are blocked; FSM tests that required disclosures appear in required states.
- **Replayable log:** any session can be reconstructed decision-by-decision with its grounding.

---

## 14. Audit log

Every **decision** writes a structured record (canonical schema = §7 `AuditEvent`; amounts in **cents**, discounts in **bps**):
```json
{
  "ts": "...", "sessionId": "...", "accountRef": "...",
  "event": "AUTH_SUCCESS | DISCLOSURE_GIVEN | SETTLEMENT_PROPOSED | ESCALATED | OUTPUT_BLOCKED",
  "detail": { "discountBps": 3000, "amountCents": 123400, "capBps": 3500 },
  "reason": "consumer unable to pay in full; offered within P-100 cap",
  "fsmStateAtEvent": "SERVE"
}
```
Covers: consent timestamp, auth attempts/outcome, disclosures given, every offer (value + cap used), F&C start/complete/decline, escalation reason, output blocks. Exportable as JSONL. This is the evidence chain that proves compliance.

---

## 15. User experience (friendly to a stressed consumer)

- Clear, low-pressure opening; the consent notice stated in one line.
- Authentication collected **conversationally, one factor at a time** (account ref → name → last4 SSN → ZIP), never pasting full identifiers in one form; "this is only used to verify you."
- On failure: no shaming; clear next step (retry / human).
- On escalation: explain what happens next and that context is carried to the human.
- Streaming output for responsiveness; a stage indicator so the consumer knows where they are.

---

## 16. Real vs. stubbed

**Real:** state machine, auth logic, policy engine + cap enforcement, settlement/plan math, special-handling + non-serviced-region escalation, three-layer anti-hallucination, audit log, F&C flow, **Neon Postgres persistence**, LLM conversation.
**Stubbed:** telephony/voice, real payments (ACH captured as a flag only), real CRM/account integration, F&C document verification (self-reported only), live human-agent connection (a complete `HandoffPackage` is produced but not actually delivered).

---

## 17. Scope — what's cut and why

- **No** real payment or telephony integration — orthogonal to the core compliant-auth-and-negotiate path; explicitly stubbed.
- **No** account registration / login system — auth is a 4-factor identity match; saves time for correctness.
- **No** full 50-state compliance matrix — we cover FDCPA/Reg F core disclosures + flow and a non-serviced-region gate; broader state rules left as an interface.
- **Prioritize** the narrow, correct end-to-end path (auth → disclosures → in-cap negotiation / escalation) over a broad demo that fakes the hard parts.

---

## 18. Production roadmap (discussion prep)

- Persist state/audit (done via Neon); make the audit log tamper-evident (hash chain).
- Real integrations: account data, payments, live human agents (warm context transfer).
- Cap config behind auditable config management + change approval, not code constants.
- Upgrade the Output Validator from regex to a stronger "number allow-list + structured templated replies."
- Multi-language, a state-compliance rules engine, A/B-tested negotiation strategies to optimize recovery.
- **Where AI should NOT be used:** amount computation, cap/eligibility decisions, state transitions, disclosure text — all deterministic; AI only touches natural language.

**Single most important metric:** **compliant self-service resolution rate** — the share of accounts reaching RESOLVED with no human in the loop and zero compliance violations. Directly maps to the north star.

---

## 19. Directory structure (planned)

```
verc/
├─ design.md                        # this document
├─ collections-reference-pack.md    # SOP (ground truth)
├─ project-brief.md                 # the brief
├─ README.md                        # run instructions + test credential cards
├─ app/
│  ├─ page.tsx                      # chat UI
│  └─ api/chat/route.ts             # orchestrator entry (streaming)
├─ lib/
│  ├─ orchestrator.ts               # FSM + Policy Gate + per-turn lifecycle
│  ├─ fsm.ts                        # ConversationState + transitions
│  ├─ llm/
│  │  ├─ nlu.ts                     # message → {action,slots,confidence}
│  │  └─ nlg.ts                     # directive → empathetic prose (streaming)
│  ├─ engine/
│  │  ├─ negotiation.ts             # limits + hierarchy + ladder + settlement/installment math
│  │  ├─ portfolios.ts              # portfolio config (cap + discountLadder)
│  │  └─ financialProfile.ts        # F&C completeness + affordability
│  ├─ specialHandling.ts            # flags + non-serviced regions → escalate
│  ├─ disclosures.ts                # SOP verbatim scripts + collector-statement template
│  ├─ validator.ts                  # outbound anti-hallucination check
│  ├─ handoff.ts                    # HandoffPackage assembly (auth-aware redaction)
│  ├─ audit.ts                      # audit log
│  └─ db/
│     ├─ store.ts                   # Store interface (session/audit/profile/resolution)
│     ├─ schema.ts                  # Neon table definitions
│     └─ seed.ts                    # read-only seed + reset (reproducibility)
├─ fixtures/                        # version-controlled account/portfolio seed data
└─ components/                      # shadcn chat components
```

---

## 20. Time budget (per the brief)

1. **Done:** read materials, pick architecture, write this design.
2. Core path (~2h): FSM + auth + policy engine + cap enforcement (happy path end-to-end).
3. Escalation / disclosures / anti-hallucination (~45min): special-handling escalation, verbatim disclosures, three-layer guard.
4. Remainder: UX polish, audit-log bonus, prepare the walkthrough. **Protect the last 30 minutes for finalizing.**
```
