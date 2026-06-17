# Verc — Founding Engineer Collaboration Day · Project Brief

> Source document for the build. Companion to `collections-reference-pack.md` (the SOP / ground truth) and `design.md` (our design decisions).

## Overview

A collaboration day: build alongside the team on the kind of problem Verc tackles. Not production work; nothing to prepare. Build it naturally, on your own laptop, with any tools/AI assistants. Ask questions as you go.

**What matters most, in order:**
1. **Getting it right** — compliance and accuracy, no hallucinations.
2. **Client outcomes** — minimizing delinquency, maximizing collections.
3. **A thoughtful experience** for the person on the other end.
4. **How quickly you iterate.**

> A narrow path that works end-to-end and is correct beats a broad demo that fakes the hard parts.

---

## The Project

Build a working prototype of a chatbot that lives on the collection agency's **consumer-facing website**. A consumer (borrower) arrives to deal with a past-due account placed with the agency. The bot should:

- Answer basic account questions (e.g. balance, what's owed, who the lender is).
- **Authenticate** the consumer before disclosing or discussing any account detail.
- **Negotiate a resolution** — a settlement (lump sum at a discount) or a payment plan — strictly within the limits configured for that account's portfolio.
- **Escalate to a human** (chat or call) when the account is ineligible for self-service or when the consumer asks.

**North star:** maximize compliant collection without a human agent in the loop.

**Hard constraint:** the bot must **never hallucinate** an amount, a date, a discount, or a policy. If it doesn't have a grounded answer, it says so or escalates.

### Who this is for
A third-party collections agency — **Meridian Recovery Services** — modeled on a real Verc customer. It collects on behalf of **client portfolios** (debt owners) for accounts from **original creditors**, under FDCPA, Reg F, TCPA, and state rules. A single off-script promise or wrong balance is a real legal and financial liability. The **Collections Reference Pack** is the anonymized SOP — treat it as ground truth.

---

## Domain rules to respect (from the SOP)

### Consent & authentication (before any account disclosure)
Give the recording-consent notice first: *"Before I proceed, this conversation may be monitored and recorded; by continuing you are providing your consent."* Then authenticate before revealing/discussing balances or terms.

For the web assistant, use the portal standard: match **account reference + last name + last 4 of SSN + ZIP code** against the account record.
> (Note: the brief says "last name"; the SOP §1.3 says "first and last name" — SOP wins. See `design.md` §5.)

If authentication fails after a reasonable number of attempts (**max three**), disclose nothing — **not even whether an account exists** — and offer a human handoff.

### Required disclosures
After authentication, state the **Mini-Miranda verbatim**: *"This is a communication from a debt collector. This is an attempt to collect a debt, and any information obtained, including this call recording, will be used for that purpose."* For **pre-legal portfolios**, also give the pre-legal disclosure. Then deliver the **collector statement**: the agency, on behalf of [client/current creditor], regarding the [original creditor] account.

### Resolution approach
Open by requesting the **balance in full**. Only if the consumer can't pay in full, work down the hierarchy: paid-in-full → balance in payments → settlement (SIF) → payment plan (PPA). Without a financial profile, an arrangement may resolve the balance over **up to 6 months**.

### Portfolio limits (never exceed)
The bot may offer **at or below** these, never above:

| Portfolio | Client / type | Max settlement discount | Max plan length |
|---|---|---|---|
| **P-100** | Northwind Capital — auto / secured | 35% | 6 months |
| **P-200** | Apex Card — credit card | 50% | 12 months |
| **P-300** | Harbor Recovery — personal (pre-legal) | 25% | 18 months |

### Special handling — escalate, never negotiate
If an account carries any of these flags, authenticate if needed, then place it on hold and escalate to a human (collection activity stops): **bankruptcy (BKY)**, **active litigation / attorney-represented**, an **active dispute (DSP)** or **verification-of-debt request (VOD)**, **fraud / identity theft (FRA)**, a **cease-and-desist / do-not-contact request (CNA/CDP)**, a **deceased borrower (DEC)**, or **active-duty military (MIL)**.

### No production data — mock your own account store
Stand up a small mock account store with enough variety to exercise the rules. Suggested scenarios:

- A clean, negotiable account on a **credit-card** portfolio (up to 50% / 12 months) — **happy path**.
- A negotiable account on the **auto** portfolio (up to 35% / 6 months) and one on the **personal/pre-legal** portfolio (up to 25% / 18 months).
- A **bankruptcy** account — must escalate, never negotiate.
- A **disputed / verification-of-debt** account — stop and escalate.
- A **cease-and-desist** account — no contact, escalate.
- An account where **authentication fails** — disclose nothing, offer handoff.

---

## What to deliver by 3:30

- A running prototype with a chat interface where the team can: identify as one of the test consumers, get authenticated, ask a basic question, and either reach a compliant settlement/plan or get escalated.
- At least **one happy path** (negotiation closes within limits) and **one escalation path** (ineligible account or auth failure) working live.
- A short walkthrough (slides, README, or talk through the code) covering architecture, anti-hallucination, limit enforcement, latency thinking, and what you cut and why.
- Your code, shared after the demo (Git repo link or zip).

---

## Presentation & discussion format (3:30 – 4:30)

~15 min presenting, then ~45 min discussion in two rounds. A conversation — expect questions throughout. Slides optional; they'd rather see the working product and how you think.

### 15-minute presentation
- **Live demo (~10 min):** the main event. In a sentence, say what you built, then run it. Show the happy path end-to-end (consent + authentication → Mini-Miranda → negotiate a settlement or plan within portfolio limits → confirm) and at least one escalation or failed-auth path.
- **How it works, in plain English (~3 min).**
- **What's real vs. stubbed (~2 min).**

### 45-minute discussion — two rounds
**1. Code walkthrough & technical deep-dive, with Naga (~30 min)** — walk through the code like a PR review:
- where the LLM sits and what it deliberately does **NOT** decide;
- where limits, eligibility, and resolution math are enforced **deterministically**;
- your anti-hallucination guardrail and how you'd **prove it's compliant** (including an **audit trail**);
- how you tested it;
- what would break in production and what you'd redesign with another month;
- where AI should **NOT** be used;
- the technical debt you knowingly took on and what you'd refactor first.

**2. Product, strategy & client experience, with Thalita and Marisa (~15 min):**
- why you built this piece first, what you'd build next, your riskiest assumptions;
- what would make it succeed with a real client, what you'd cut, the single metric that matters most;
- how you'd explain this to a client, how you'd onboard a new portfolio, how you'd define success;
- where a stressed consumer might get confused or hit friction.

---

## How they'll evaluate (priority order)

1. **Compliance & accuracy** — No invented numbers or policy. Limits and eligibility enforced **deterministically**, not left to the model's goodwill. Disclosures present when required.
2. **Client outcomes** — Minimize delinquency, maximize collections; sensible negotiation that maximizes recovery within the ceiling.
3. **User experience** — Responsive, clear, empathetic to a stressed consumer; clean human handoff.
4. **Speed of iteration** — How much working, sensible software you produced, and how you used your tools.

### Bonus (only after the core works)
- **Voice option** — let the consumer speak instead of type.
- **Live human handoff** — connect to a human via chat or call, passing full context.
- **An audit log** of every decision the bot made and why (they care a lot about exam readiness).

---

## Ground rules
- Work in your own environment. Use any stack and AI assistants.
- Keep code shareable: clean repo or zip with a short README.
- Ask questions early and often — handling ambiguity is part of this.
- Don't gold-plate. A narrow path that works end-to-end and is correct beats a broad demo that fakes the hard parts.
- Fine to stub external services (telephony, payments). Be explicit about real vs. stubbed.

## Materials provided
- **Collections Reference Pack** (single PDF) — the agency's SOP; ground the bot in it. (Saved locally as `collections-reference-pack.md`.)
- **No account data** — mock your own store (production data only exists at integration).

## Suggested time budget
- ~30 min: read, set up, pick an architecture.
- ~2 hours: core authenticate-and-negotiate path with limit enforcement.
- ~45 min: escalation, disclosures, anti-hallucination guardrail.
- Remainder: UX polish, a bonus if time, prepare the walkthrough.
- **Protect the last 30 minutes for finalizing.**
