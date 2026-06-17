# Verc — Meridian Recovery Compliant Collections Chatbot

A working prototype of a compliant debt-collection chatbot for the consumer-facing
website of a third-party agency (**Meridian Recovery Services**). It takes recording
consent, authenticates the consumer, recites required disclosures, and negotiates a
settlement or payment plan **strictly within each portfolio's hard caps** — or escalates
to a human when the account can't be self-serviced or the consumer asks.

> **Design priorities (in order):** Compliance & accuracy (never hallucinate) → Client
> outcomes (maximize recovery within caps) → UX for a stressed consumer → Speed of iteration.

Full design rationale lives in [`design.md`](./design.md); the agency SOP (ground truth)
is [`collections-reference-pack.md`](./collections-reference-pack.md).

---

## Core idea: the LLM *speaks*; deterministic code *computes and decides*

The LLM is confined to **two narrow jobs** — understanding (NLU: message → structured
intent) and speaking (NLG: phrasing a directive the orchestrator already decided). It
**never** produces a number, drives a state transition, decides eligibility, or emits a
verbatim disclosure. Every amount comes from one of three non-LLM sources: account data,
the deterministic policy engine, or SOP verbatim scripts. This makes out-of-bounds offers
and hallucinated figures **structurally impossible**, not merely discouraged.

Three layers of anti-hallucination defense:
1. **Structural** — the LLM has no surface to originate a fact (NLU emits no prose;
   disclosures bypass the LLM entirely).
2. **Deterministic** — all math/caps/eligibility computed by pure functions *before* the
   directive is built; even a flawless rendering can't exceed a cap.
3. **Output Validator** — a server-side allow-list backstop: every currency amount,
   percentage, month count, and date in the model's output must be in the turn's
   authorized set, or the text is blocked and replaced with a safe deterministic fallback
   (logged as `OUTPUT_BLOCKED`).

---

## Setup & running

Requires Node 22+ (uses native TypeScript execution and `--env-file`).

```bash
npm install

# .env.local must contain DATABASE_URL (Neon Postgres) and ANTHROPIC_API_KEY.
# (Both are already present in this submission's .env.local — gitignored, never committed.)

npm run db:seed     # create schema + load read-only fixtures (8 test accounts, 3 portfolios)
npm run dev         # http://localhost:3000
```

Other scripts:

```bash
npm test            # engine + validator unit tests (caps, money math, hallucination blocks)
npm run db:reset    # wipe mutable tables (sessions/audit/profiles/resolutions), re-seed pristine
node --env-file=.env.local --experimental-strip-types scripts/sim.ts <scenario>
                    # scripted end-to-end run: happy | plan_fc | bankruptcy | region | dispute | authfail
```

### Configuration
All tunables live in **`lib/config.ts`** with defaults that match the design; each can be
overridden via an environment variable (see `.env.local`) without touching code:

| Env var | Default | Meaning |
|---|---|---|
| `LLM_MODEL` | `claude-sonnet-4-6` | Claude model for NLU + NLG |
| `NLU_HISTORY_TURNS` / `NLG_HISTORY_TURNS` | 8 / 6 | recent transcript turns given to each LLM call |
| `AUTH_MAX_ATTEMPTS` | 3 | failed verifications before disclose-nothing handoff (SOP §1.4) |
| `NLU_CONFIDENCE_THRESHOLD` | 0.45 | below this, clarify instead of acting |
| `INSTALLMENT_MIN_MONTHS` | 2 | floor on number of installments |
| `BIF_SIF_INSTALLMENT_MAX_MONTHS` | 4 | BIF/SIF "in payments" bound (SOP §3.2) |
| `NO_PROFILE_PPA_CAP_MONTHS` | 6 | plan-length cap without a financial profile (SOP §3.5) |
| `VERIFY_FUNDS_THRESHOLD_CENTS` | 150000 | single payment above this requires funds verification (SOP §3.1) |

Per-portfolio caps and discount ladders live in `lib/engine/portfolios.ts` (one row per portfolio).

### Demo reproducibility
`Account` and `Portfolio` are **read-only at runtime** — never mutated. All test writes
(F&C profiles, sessions, audit, resolutions) go to separate mutable tables. `npm run db:reset`
restores a pristine state from version-controlled fixtures, so every demo is identical.

---

## Test credential cards

Authenticate with **four factors**: `account ref + name (first & last) + last-4 SSN + ZIP`
(the SOP's digital self-service standard). You can provide them **all at once, in any
combination, or one at a time** — the LLM extracts whichever factors a message contains and
deterministic code normalizes/validates them (digits-only, exact lengths, `MRS-` pattern)
before an exact-match check. (E.g. "yes — MRS-204418, Maria Gonzalez, 4821, 60616" logs in
in one message.)

| # | Scenario | Account Ref | Name | last4 | ZIP | Expected |
|---|---|---|---|---|---|---|
| 1 | **Happy path** (credit card, 50% / 12mo) | `MRS-204418` | Maria Gonzalez | 4821 | 60616 | settle/plan within cap |
| 2 | Auto (35% / 6mo) | `MRS-100937` | James Carter | 7390 | 75201 | settle within cap |
| 3 | **Personal pre-legal** (25% / 18mo) | `MRS-300256` | Aisha Bello | 1156 | 30307 | pre-legal disclosure + F&C unlock |
| 4 | **Bankruptcy** | `MRS-204550` | Robert Kim | 9043 | 98101 | escalate, never negotiate |
| 5 | **Dispute / VOD** | `MRS-100712` | Linda Foster | 5567 | 85004 | stop & escalate |
| 6 | **Cease & desist** | `MRS-300489` | Daniel Reyes | 3320 | 10025 | no contact, escalate |
| 7 | **Auth fails** | `MRS-559000` | Alex Turner | 0000 | 00000 | 3 failures → disclose nothing → handoff |
| 8 | **Region not serviced** (PR) | `MRS-300781` | Carmen Diaz | 6624 | 00926 | escalate after auth |

**Try these once authenticated** (account 1 or 3):
- "I can't pay the whole thing" → anchored settlement; "is that the best you can do?" steps toward the cap.
- "I can only do $150 a month" (account 3) → triggers F&C; answer the few questions to unlock an 18-month plan.
- "I never opened this account" → dispute → immediate escalation.
- "I want to talk to a human" → escalation in any state, with a full handoff package.

Click **View audit log** in the UI to see the compliance evidence chain for the session.

---

## Architecture

```
Chat UI (Next.js + Tailwind)
   │  POST /api/chat { sessionId, message }
Orchestrator (lib/orchestrator.ts) — deterministic per-turn lifecycle:
   receive → NLU classify → policy gate (auth/flags) → state machine picks action
   → engine/disclosure → build directive → NLG render → Output Validator → persist + audit
   ├─ LLM (lib/llm)        NLU (structured intent) + NLG (phrasing) only
   ├─ Engine (lib/engine)  caps, ladder, settlement/installment math — pure functions
   ├─ Disclosures          verbatim Mini-Miranda / pre-legal / collector statement
   ├─ Special handling     flags + non-serviced regions + escalation intents → escalate
   ├─ Validator            outbound number/date allow-list (backstop)
   ├─ Handoff              complete package, auth-aware redaction
   └─ Audit                append-only evidence chain
Neon Postgres (lib/db) — read-only: account/portfolio · mutable: session/message/profile/audit/resolution
```

- **State machine:** `CONSENT → AUTH → [post-auth gate] → DISCLOSURES → SERVE → RESOLVED | ESCALATED`.
  The post-auth gate checks special-handling flags / non-serviced region *before* any
  balance is disclosed, so flagged accounts hear only the Mini-Miranda + an escalation message.
- **Negotiation:** hierarchy PIF/BIF → BIF installments (2–4) → SIF → SIF installments → PPA.
  Settlements follow a per-portfolio discount **ladder** (anchor low, step to the cap on
  rejection, never past it). Installment schedules **always sum to exactly the principal**.
- **F&C (financial profile):** gathered conversationally to unlock plans longer than 6
  months (up to the portfolio max). Self-reported, no proof required. Optional — clean
  decline/skip/abandon handling.

---

## What's real vs. stubbed

**Real:** state machine, 4-factor auth, policy engine + cap enforcement, settlement/plan
math (integer cents / bps), special-handling + non-serviced-region escalation, three-layer
anti-hallucination + Output Validator, audit log, F&C flow, **Neon Postgres persistence**,
live Claude NLU/NLG.

**Stubbed (clearly marked):** telephony/voice, real payments (ACH captured as a flag only),
real CRM/account integration, F&C document verification (self-reported), live human-agent
connection (a complete `HandoffPackage` is produced and persisted, but not delivered to a
real person). Broad 50-state compliance matrix is out of scope (core FDCPA/Reg F disclosures
+ a non-serviced-region gate are implemented).

---

## Testing

`npm test` runs deterministic unit tests with zero LLM/network dependency:
- **Engine:** schedules sum to exactly the principal (no over-collection), settlements
  never exceed the portfolio cap across fuzzed inputs, F&C unlock raises the plan ceiling.
- **Validator:** authorized figures pass; fabricated amounts/discounts/terms/dates are blocked.

`scripts/sim.ts` exercises full conversations through the real orchestrator (NLU + engine +
DB + NLG + validator) for every required path.

### Production next steps (discussion)
Tamper-evident audit (hash chain) · cap config behind change-managed config (not constants)
· stronger validator (templated replies over regex) · real integrations (payments, warm
human transfer) · multi-language · a state-compliance rules engine. **Single most important
metric:** compliant self-service resolution rate (RESOLVED with no human and zero violations).
```
# verc
