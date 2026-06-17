import { sql } from "./client.ts";
import type {
  Account,
  AuthFields,
  FinancialProfile,
  FlagCode,
  FsmState,
  NegotiationState,
  PortfolioId,
} from "../types.ts";

// The single access path to Postgres (design §7). Read-only seed tables
// (account/portfolio) are never written here; only the orchestrator's mutable
// state (session/message/profile/audit/resolution) is.

export interface SessionRecord {
  sessionId: string;
  fsmState: FsmState;
  consentAt: string | null;
  authAttempts: number;
  authFields: AuthFields | null;
  authedAccountRef: string | null;
  negotiation: NegotiationState | null;
}

export interface ChatMessage {
  role: "consumer" | "assistant";
  content: string;
  ts: string;
}

export interface AuditRecord {
  sessionId: string;
  accountRef?: string | null;
  event: string;
  detail?: Record<string, unknown>;
  reason?: string;
  fsmStateAtEvent?: string;
}

export interface ResolutionRecord {
  sessionId: string;
  accountRef: string;
  type: string;
  amountCents: number;
  discountBps?: number;
  months?: number | null;
  schedule?: number[] | null;
  verifyFunds?: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function rowToAccount(r: any): Account {
  return {
    accountRef: r.account_ref,
    firstName: r.first_name,
    lastName: r.last_name,
    last4ssn: r.last4ssn,
    zip: r.zip,
    portfolioId: r.portfolio_id as PortfolioId,
    originalCreditor: r.original_creditor,
    currentCreditor: r.current_creditor,
    balanceCents: r.balance_cents,
    receiveDate:
      typeof r.receive_date === "string"
        ? r.receive_date
        : new Date(r.receive_date).toISOString().slice(0, 10),
    flags: (r.flags ?? []) as FlagCode[],
    stateCode: r.state_code,
  };
}

function rowToSession(r: any): SessionRecord {
  return {
    sessionId: r.session_id,
    fsmState: r.fsm_state as FsmState,
    consentAt: r.consent_at ? new Date(r.consent_at).toISOString() : null,
    authAttempts: r.auth_attempts,
    authFields: r.auth_fields ?? null,
    authedAccountRef: r.authed_account_ref,
    negotiation: r.negotiation ?? null,
  };
}

export const store = {
  async findAccountByRef(accountRef: string): Promise<Account | null> {
    const rows = await sql`SELECT * FROM account WHERE account_ref = ${accountRef}`;
    return rows[0] ? rowToAccount(rows[0]) : null;
  },

  // Four-factor identity match (design §5). Name compared case-insensitively.
  async authenticate(f: {
    accountRef: string;
    firstName: string;
    lastName: string;
    last4ssn: string;
    zip: string;
  }): Promise<Account | null> {
    const rows = await sql`
      SELECT * FROM account
      WHERE account_ref = ${f.accountRef}
        AND lower(first_name) = lower(${f.firstName})
        AND lower(last_name)  = lower(${f.lastName})
        AND last4ssn = ${f.last4ssn}
        AND zip = ${f.zip}`;
    return rows[0] ? rowToAccount(rows[0]) : null;
  },

  async createSession(sessionId: string): Promise<SessionRecord> {
    const rows = await sql`
      INSERT INTO session (session_id, fsm_state, auth_attempts)
      VALUES (${sessionId}, 'CONSENT', 0)
      RETURNING *`;
    return rowToSession(rows[0]);
  },

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const rows = await sql`SELECT * FROM session WHERE session_id = ${sessionId}`;
    return rows[0] ? rowToSession(rows[0]) : null;
  },

  async updateSession(
    sessionId: string,
    patch: Partial<{
      fsmState: FsmState;
      consentAt: string;
      authAttempts: number;
      authFields: AuthFields;
      authedAccountRef: string;
      negotiation: NegotiationState;
    }>,
  ): Promise<void> {
    const neg = patch.negotiation ? JSON.stringify(patch.negotiation) : null;
    const authFields = patch.authFields ? JSON.stringify(patch.authFields) : null;
    await sql`
      UPDATE session SET
        fsm_state          = COALESCE(${patch.fsmState ?? null}, fsm_state),
        consent_at         = COALESCE(${patch.consentAt ?? null}::timestamptz, consent_at),
        auth_attempts      = COALESCE(${patch.authAttempts ?? null}, auth_attempts),
        auth_fields        = COALESCE(${authFields}::jsonb, auth_fields),
        authed_account_ref = COALESCE(${patch.authedAccountRef ?? null}, authed_account_ref),
        negotiation        = COALESCE(${neg}::jsonb, negotiation),
        updated_at         = now()
      WHERE session_id = ${sessionId}`;
  },

  // Explicit set (incl. clearing to null) — used to reset accumulated auth
  // factors after a failed attempt. updateSession's COALESCE can't null a field.
  async setAuthFields(sessionId: string, fields: AuthFields | null): Promise<void> {
    const v = fields ? JSON.stringify(fields) : null;
    await sql`
      UPDATE session SET auth_fields = ${v}::jsonb, updated_at = now()
      WHERE session_id = ${sessionId}`;
  },

  async appendMessage(
    sessionId: string,
    role: ChatMessage["role"],
    content: string,
  ): Promise<void> {
    await sql`
      INSERT INTO message (session_id, role, content)
      VALUES (${sessionId}, ${role}, ${content})`;
  },

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const rows = await sql`
      SELECT role, content, ts FROM message
      WHERE session_id = ${sessionId} ORDER BY id ASC`;
    return rows.map((r: any) => ({
      role: r.role,
      content: r.content,
      ts: new Date(r.ts).toISOString(),
    }));
  },

  async getFinancialProfile(
    sessionId: string,
  ): Promise<FinancialProfile | null> {
    const rows = await sql`
      SELECT * FROM financial_profile WHERE session_id = ${sessionId}`;
    if (!rows[0]) return null;
    const r = rows[0] as any;
    return {
      netMonthlyIncomeCents: r.net_monthly_income_cents ?? undefined,
      housingPaymentCents: r.housing_payment_cents ?? undefined,
      vehiclePaymentsCents: r.vehicle_payments_cents ?? undefined,
      otherObligationsCents: r.other_obligations_cents ?? undefined,
      payCadence: r.pay_cadence ?? undefined,
      lastPayDate: r.last_pay_date
        ? new Date(r.last_pay_date).toISOString().slice(0, 10)
        : undefined,
      hasCheckingAccount: r.has_checking_account ?? undefined,
      callbackNumber: r.callback_number ?? undefined,
      completeness: r.completeness,
    };
  },

  async upsertFinancialProfile(
    sessionId: string,
    accountRef: string | null,
    p: Partial<FinancialProfile>,
  ): Promise<void> {
    await sql`
      INSERT INTO financial_profile (
        session_id, account_ref, net_monthly_income_cents, housing_payment_cents,
        vehicle_payments_cents, other_obligations_cents, pay_cadence, last_pay_date,
        has_checking_account, callback_number, completeness
      ) VALUES (
        ${sessionId}, ${accountRef},
        ${p.netMonthlyIncomeCents ?? null}, ${p.housingPaymentCents ?? null},
        ${p.vehiclePaymentsCents ?? null}, ${p.otherObligationsCents ?? null},
        ${p.payCadence ?? null}, ${p.lastPayDate ?? null}::date,
        ${p.hasCheckingAccount ?? null}, ${p.callbackNumber ?? null},
        ${p.completeness ?? "incomplete"}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        account_ref              = COALESCE(EXCLUDED.account_ref, financial_profile.account_ref),
        net_monthly_income_cents = COALESCE(EXCLUDED.net_monthly_income_cents, financial_profile.net_monthly_income_cents),
        housing_payment_cents    = COALESCE(EXCLUDED.housing_payment_cents, financial_profile.housing_payment_cents),
        vehicle_payments_cents   = COALESCE(EXCLUDED.vehicle_payments_cents, financial_profile.vehicle_payments_cents),
        other_obligations_cents  = COALESCE(EXCLUDED.other_obligations_cents, financial_profile.other_obligations_cents),
        pay_cadence              = COALESCE(EXCLUDED.pay_cadence, financial_profile.pay_cadence),
        last_pay_date            = COALESCE(EXCLUDED.last_pay_date, financial_profile.last_pay_date),
        has_checking_account     = COALESCE(EXCLUDED.has_checking_account, financial_profile.has_checking_account),
        callback_number          = COALESCE(EXCLUDED.callback_number, financial_profile.callback_number),
        completeness             = EXCLUDED.completeness,
        updated_at               = now()`;
  },

  async appendAudit(e: AuditRecord): Promise<void> {
    await sql`
      INSERT INTO audit_event (session_id, account_ref, event, detail, reason, fsm_state_at_event)
      VALUES (
        ${e.sessionId}, ${e.accountRef ?? null}, ${e.event},
        ${e.detail ? JSON.stringify(e.detail) : null}::jsonb,
        ${e.reason ?? null}, ${e.fsmStateAtEvent ?? null}
      )`;
  },

  async getAudit(sessionId: string): Promise<any[]> {
    const rows = await sql`
      SELECT ts, event, account_ref, detail, reason, fsm_state_at_event
      FROM audit_event WHERE session_id = ${sessionId} ORDER BY id ASC`;
    return rows.map((r: any) => ({
      ts: new Date(r.ts).toISOString(),
      event: r.event,
      accountRef: r.account_ref,
      detail: r.detail,
      reason: r.reason,
      fsmStateAtEvent: r.fsm_state_at_event,
    }));
  },

  async saveResolution(r: ResolutionRecord): Promise<void> {
    await sql`
      INSERT INTO resolution (
        session_id, account_ref, type, amount_cents, discount_bps, months, schedule, verify_funds
      ) VALUES (
        ${r.sessionId}, ${r.accountRef}, ${r.type}, ${r.amountCents},
        ${r.discountBps ?? 0}, ${r.months ?? null}, ${r.schedule ?? null},
        ${r.verifyFunds ?? false}
      )`;
  },
};
