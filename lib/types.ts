// Shared domain types. Money is ALWAYS integer cents; discounts/rates are basis
// points (bps): 3500 = 35%. Zero floating point in money math (design §7/§8).

export type PortfolioId = "P-100" | "P-200" | "P-300";

export interface Portfolio {
  portfolioId: PortfolioId;
  clientName: string;
  type: string;
  maxDiscountBps: number; // hard ceiling, e.g. 3500
  maxPlanMonths: number; // hard ceiling, e.g. 6
  isPreLegal: boolean;
  discountLadderBps: number[]; // ordered; LAST tier === maxDiscountBps
  miniMirandaVariant?: string;
}

// SOP §4.1 special-handling codes (account-borne flags).
export type FlagCode =
  | "BKY" // bankruptcy
  | "DEC" // deceased
  | "MIL" // active-duty military
  | "FRA" // fraud / identity theft
  | "VOD" // verification of debt
  | "DSP" // disputes the debt
  | "CDP" // cease & desist (brief alias CNA)
  | "HRA" // hardship
  | "APP" // paid/settled prior
  | "MOS" // moved out of state/country
  | "DBM" // debt manager / attorney
  | "ATTY";

export interface Account {
  accountRef: string;
  firstName: string;
  lastName: string;
  last4ssn: string;
  zip: string;
  portfolioId: PortfolioId;
  originalCreditor: string;
  currentCreditor: string; // client / current creditor
  balanceCents: number;
  receiveDate: string; // ISO date — used in the collector statement (§6)
  flags: FlagCode[];
  stateCode: string; // compliance + non-serviced-region gate (§10)
  // Pre-legal suppression rule modeling (§6); default false.
  priorArrangementBreached?: boolean;
  nsfPayment?: boolean;
}

// --- Conversation / session state (design §7) ---

export type FsmState =
  | "CONSENT"
  | "AUTH"
  | "DISCLOSURES"
  | "SERVE"
  | "RESOLVED"
  | "ESCALATED";

export type NegotiationStage =
  | "PIF"
  | "BIF_INSTALLMENTS"
  | "SIF"
  | "SIF_INSTALLMENTS"
  | "PPA";

export type FcStatus = "none" | "gathering" | "sufficient" | "declined";

export interface Offer {
  kind: "SETTLEMENT" | "INSTALLMENTS";
  stage: NegotiationStage;
  amountCents?: number; // settlement lump
  discountBps?: number;
  months?: number;
  monthlyCents?: number;
  schedule?: number[]; // installment amounts in cents; sums to principal
  capUsedBps?: number;
  verifyFunds?: boolean; // a single payment > $1,500 (SOP §3.1)
  reason: string;
}

export interface NegotiationState {
  stage: NegotiationStage;
  settlementTierIndex: number;
  fcStatus: FcStatus;
  offersExtended: Offer[];
  currentOffer?: Offer; // offer currently on the table, awaiting accept/reject
  awaitingConfirmation?: boolean; // confirmation gate before finalizing (§8)
  pendingFcOffer?: Offer; // plan that triggered an F&C offer, resumed on unlock
}

export interface AuthFields {
  accountRef?: string;
  firstName?: string;
  lastName?: string;
  last4ssn?: string;
  zip?: string;
}

export interface FinancialProfile {
  netMonthlyIncomeCents?: number;
  housingPaymentCents?: number;
  vehiclePaymentsCents?: number; // 0 === "no vehicle payment"
  otherObligationsCents?: number;
  payCadence?: string;
  lastPayDate?: string;
  hasCheckingAccount?: boolean; // ACH — STUBBED
  callbackNumber?: string; // + callback consent — STUBBED
  completeness: "incomplete" | "sufficient";
}

// --- Engine result types ---

export interface SettlementResult {
  decision: "accept" | "counter" | "reject";
  amountCents: number; // the settled (lump) amount
  discountAppliedBps: number;
  capBps: number;
  verifyFunds: boolean; // single payment > $1,500 (SOP §3.1)
  reason: string;
}

export interface InstallmentResult {
  decision: "accept" | "counter" | "offer_fc";
  stage: NegotiationStage;
  months: number;
  monthlyCents: number;
  schedule: number[]; // sums to principal exactly
  maxMonths: number;
  principalCents: number;
  verifyFunds: boolean;
  reason: string;
}
