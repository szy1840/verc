import { sql } from "./client.ts";

// Table DDL (design §7). Read-only: portfolio, account. Mutable: session,
// message, financial_profile, audit_event, resolution.

export async function createTables(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS portfolio (
      portfolio_id        text PRIMARY KEY,
      client_name         text NOT NULL,
      type                text NOT NULL,
      max_discount_bps    int  NOT NULL,
      max_plan_months     int  NOT NULL,
      is_pre_legal        boolean NOT NULL,
      discount_ladder_bps int[] NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS account (
      account_ref       text PRIMARY KEY,
      first_name        text NOT NULL,
      last_name         text NOT NULL,
      last4ssn          text NOT NULL,
      zip               text NOT NULL,
      portfolio_id      text NOT NULL REFERENCES portfolio(portfolio_id),
      original_creditor text NOT NULL,
      current_creditor  text NOT NULL,
      balance_cents     int  NOT NULL,
      receive_date      date NOT NULL,
      flags             text[] NOT NULL DEFAULT '{}',
      state_code        text NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS session (
      session_id         text PRIMARY KEY,
      fsm_state          text NOT NULL,
      consent_at         timestamptz,
      auth_attempts      int  NOT NULL DEFAULT 0,
      auth_fields        jsonb,
      authed_account_ref text REFERENCES account(account_ref),
      negotiation        jsonb,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS message (
      id         bigserial PRIMARY KEY,
      session_id text NOT NULL REFERENCES session(session_id),
      role       text NOT NULL,           -- 'consumer' | 'assistant'
      content    text NOT NULL,
      ts         timestamptz NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS financial_profile (
      session_id              text PRIMARY KEY REFERENCES session(session_id),
      account_ref             text,
      net_monthly_income_cents int,
      housing_payment_cents    int,
      vehicle_payments_cents   int,
      other_obligations_cents  int,
      pay_cadence              text,
      last_pay_date            date,
      has_checking_account     boolean,
      callback_number          text,
      completeness             text NOT NULL DEFAULT 'incomplete',
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS audit_event (
      id                bigserial PRIMARY KEY,
      ts                timestamptz NOT NULL DEFAULT now(),
      session_id        text NOT NULL,
      account_ref       text,
      event             text NOT NULL,
      detail            jsonb,
      reason            text,
      fsm_state_at_event text
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS resolution (
      id            bigserial PRIMARY KEY,
      session_id    text NOT NULL,
      account_ref   text NOT NULL,
      type          text NOT NULL,        -- PIF | BIF | SIF | SIF_INSTALLMENTS | PPA
      amount_cents  int  NOT NULL,
      discount_bps  int  NOT NULL DEFAULT 0,
      months        int,
      schedule      int[],
      verify_funds  boolean NOT NULL DEFAULT false,
      agreed_at     timestamptz NOT NULL DEFAULT now()
    )`;

  // Idempotent migrations for tables that may predate a column.
  await sql`ALTER TABLE session ADD COLUMN IF NOT EXISTS auth_fields jsonb`;
}

// Reproducibility (§7): truncate mutable tables; leave read-only seed intact.
export async function truncateMutable(): Promise<void> {
  await sql`TRUNCATE resolution, audit_event, financial_profile, message, session RESTART IDENTITY CASCADE`;
}
