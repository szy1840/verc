# Collections Reference Pack — Anonymized Sample SOP

> **Operating agency:** Meridian Recovery Services (fictional third-party collection agency for this exercise). It collects on behalf of **client portfolios** (debt owners) for accounts from **original creditors**.
>
> This pack is an anonymized composite of real-world collections procedures, prepared for the Verc founding-engineer collaboration day. Operational rules, scripts, and compliance requirements are representative of how a real agency works. **Build the chatbot as if it operated for this agency. Treat this pack as the ground truth.**

## Contents
| Section | Topic |
|---|---|
| 1 | Customer Authentication & Consent |
| 2 | Disclosures & Call Scripts |
| 3 | Negotiation & Resolution |
| 4 | Special Handling & Escalation |
| 5 | Compliance & State Rules |

### How to use it
- Treat this pack as the ground truth the chatbot must follow.
- Give the recording-consent notice, **then authenticate before disclosing anything**.
- State the Mini-Miranda exactly as written; add the pre-legal disclosure for pre-legal portfolios.
- Open by requesting the balance in full, then work the resolution hierarchy within each portfolio's limits.
- Escalate any special-handling account (bankruptcy, dispute, fraud, cease-and-desist, deceased, etc.) instead of negotiating.
- No production account data — mock a small account store covering representative scenarios.

---

## 1. Customer Authentication & Consent

### 1.1 Recording consent (before anything else)
On every contact, give the recording-consent notice **before asking any questions**:
> "Before I proceed, this conversation may be monitored and recorded; by continuing you are providing your consent."

### 1.2 Soft ID
Confirm you're talking to the right consumer **by name** (including suffix if on the account) before disclosing that this is a debt-collection matter.

### 1.3 Authentication
Authenticate per client directive before discussing account details. Two patterns are used:
- **Inbound (consumer provides):** the consumer supplies **any one of**: full date of birth, last 4 of SSN, or current/previous full home address.
- **Outbound (agent provides, consumer confirms):** the agent states an identifier (date of birth or full mailing address) and the consumer confirms.

**Digital self-service (chatbot / payment portal).** For the web assistant, authenticate with the portal standard:
> **account reference + first and last name + last 4 of SSN + ZIP code**, matched to the account record.

Clearly record **how** the consumer was verified.

### 1.4 Failed authentication
- If the consumer cannot be authenticated, **do not disclose any account information, including whether an account exists**.
- On a wrong-party contact, apologize and end the interaction.
- Offer a human handoff / callback rather than continuing in self-service.

### 1.5 Disclose your name before requesting payment
In several states, before discussing payment with an inbound caller the collector must clearly disclose their full name to the consumer or authorized third party. The assistant should identify itself as a representative of the agency.

---

## 2. Disclosures & Call Scripts

### 2.1 Mini-Miranda (verbatim)
> "This is a communication from a debt collector. This is an attempt to collect a debt, and any information obtained, including this call recording, will be used for that purpose."

*Note: some client portfolios use slight wording variants; use the variant configured for the portfolio. The required elements are identical.*

### 2.2 Inbound greeting
> "Thank you for contacting Meridian Recovery Services. My name is [assistant]. This conversation may be monitored and recorded; by continuing you are providing your consent. How may I help you?"

### 2.3 Opening / collector statement
After authentication and the Mini-Miranda:
> "I am with Meridian Recovery Services on behalf of [client / current creditor] in regard to your [original creditor] account. Your account was placed with our office as of [receive date] and reflects a balance of [total balance]. It is my goal to resolve this with you in a courteous and professional manner. How can I help you resolve your balance today?"

### 2.4 Pre-legal disclosure (only for pre-legal portfolios)
> "Please be advised that your account has been placed with our office in a pre-legal status. Failure to resolve this matter may result in your account being reviewed by an attorney in your state for possible legal action to collect the balance due."

**Do not** recite the pre-legal language if a prior arrangement has been breached or when calling about an NSF payment.

### 2.5 Closing statement
> "Is there anything else I can help with today? If you have further questions, you can reach us through the agency's published contact channels."

### 2.6 Limited-content message (voicemail)
Verbatim, add nothing and omit nothing:
> "This is a message from Meridian Recovery Services. Please contact us at [published number], extension [ext]."

A Spanish-language version is available. **Do not leave voicemails in states that prohibit them** (see Section 5).

---

## 3. Negotiation & Resolution

### 3.1 Open with the balance in full
Every conversation begins with a request for the **balance in full (BIF)**. Only if the consumer cannot pay in full do you move down the resolution hierarchy. **Verify funds on any payment over $1,500.**

### 3.2 Resolution hierarchy
| Option | Meaning |
|---|---|
| **PIF / BIF** | Paid in full / balance in full, ideally by ACH today. |
| **BIF in payments** | Balance in full split across **2–4** scheduled payments. |
| **SIF** | Settled in full — accept less than the full balance, **within the portfolio's max discount**. |
| **SIF in payments** | Settlement paid across multiple scheduled payments (per client rules). |
| **PPA** | Temporary payment plan arrangement, then re-evaluate. |

### 3.3 Portfolio limits (never exceed)
Each client portfolio sets a maximum settlement discount and a maximum plan length. Offer **at or below** the ceiling; anything beyond requires human approval and is out of scope for self-service.

| Portfolio | Type | Max settlement discount | Max plan length |
|---|---|---|---|
| **P-100** | Auto / secured | 35% | 6 months |
| **P-200** | Credit card | 50% | 12 months |
| **P-300** | Personal (pre-legal eligible) | 25% | 18 months |

### 3.4 Financial profile (F&C) to support an arrangement
For longer or temporary arrangements, gather a full-and-complete financial picture **as a conversation, not an interrogation**: income and pay cadence, employer, monthly household income, major obligations (housing, vehicles), and bank account status. Use it to size a realistic arrangement.

### 3.5 If the consumer declines a financial profile
Policy: without a financial profile, an arrangement may be set to **resolve the balance over a period of up to 6 months**. Preferred payment method is an electronic check / ACH.

### 3.6 Payment verification (NACHA / Reg E)
- State the payment-authorization terms and obtain **explicit approval** to proceed: arrangement type, amount(s), and date(s).
- For a single payment dated **within 5 days**, capture bank name, name on the account, routing number, and account number, and have the consumer **repeat the routing and account numbers back** for verification.
- Confirm the cutoff for changes (e.g., adjustments requested by 11 AM the day before a scheduled post).

> **Note for the build:** limits, eligibility, and the resolution math should be enforced **deterministically** — never left to the model to decide. The assistant should never offer a discount or term beyond the portfolio ceiling, and never invent a balance, date, or policy.

---

## 4. Special Handling & Escalation

### 4.1 Escalate — do not negotiate
If any of the following is present, the assistant authenticates if needed, then places the account **on hold** and escalates to a human. **Collection activity stops** until the matter is processed.

| Code | Status | Example trigger language |
|---|---|---|
| **BKY** | Bankruptcy pending | "I filed for bankruptcy / I contacted my attorney about this debt." |
| **DEC** | Deceased | "My husband passed away last month." |
| **MIL** | Active-duty military | "I'm deploying overseas with the service." |
| **FRA** | Fraud / identity theft | "I never had an account with that bank." |
| **VOD** | Verification of debt requested | "Can you send me something about this? I don't remember it." |
| **DSP** | Disputes the debt | "I don't owe that much on that account." |
| **CDP** | Cease & desist / do-not-contact (partial / full) | "Stop contacting me about this." |
| **HRA** | Hardship | "I had a stroke; I can't put anything toward this." |
| **APP** | Account paid/settled prior | "I settled this years ago with another agency." |
| **MOS** | Moved out of state/country | "I no longer live in the United States." |
| **DBM / ATTY** | Debt manager / attorney-represented | "I'm in a debt-consolidation program / my attorney handles this." |

### 4.2 Dispute handling
Treat dispute and verification-of-debt requests as a hold: stop collection activity, log the request, and route it for processing. **All New York dispute types are handled like a verification-of-debt request, except fraud.**

### 4.3 Third-party contact
Before asking a third party for location information, give the recording-consent notice. **Do not disclose the debt to third parties.** Obtain a third party's full name and relationship to the consumer for the record.

---

## 5. Compliance & State Rules

### 5.1 Frameworks
All activity must comply with the **FDCPA, Regulation F, the TCPA, and applicable state rules**. The items below are the most operationally relevant; they are illustrative and not exhaustive.

### 5.2 Contact-frequency caps (state examples)
| State | Cap on contacts (calls, messages, letters) |
|---|---|
| District of Columbia | 3 per week |
| Massachusetts | 2 per week |
| Washington | 3 per week |
| New York | 2 per week |

### 5.3 No voicemail / messages
Do not leave a voice message (to any party) in **New Jersey, New York, or Pennsylvania**. Messages to third parties should only be left with an authorized third party.

### 5.4 Third-party / spousal contact
In **California**, written permission is required to speak with anyone other than the consumer or spouse. A set of non-spousal states further restrict spousal discussion. Place-of-employment contact is restricted or prohibited in several states.

### 5.5 Recording-disclosure-at-outset states
Provide the recording disclosure at the outset of the call in **two-party-consent states** (e.g., California, Connecticut, Delaware, Florida, Illinois, Maryland, Massachusetts, Michigan, Missouri, New Hampshire, Pennsylvania, Washington). As a default, the assistant gives the consent notice on **every** contact.

### 5.6 Regions not serviced
Do not collect on accounts with addresses in: **Armed Forces (AA/AE/AP), Guam, Northern Mariana Islands, Puerto Rico, U.S. Virgin Islands, Micronesia, Marshall Islands, Palau,** and other listed Pacific territories.

### 5.7 Preferred-language prompt
Ask the preferred-language question for residents of states that require it (e.g., New Mexico, California, New York City).

### 5.8 Credit reporting (CBR)
The agency **does not report to credit bureaus** on behalf of its clients. Direct credit-reporting questions to the client and/or the credit reporting agencies; some clients delete the trade line on a paid- or settled-in-full outcome.
