import { sql } from "./client.ts";
import { createTables, truncateMutable } from "./schema.ts";
import { PORTFOLIOS } from "../engine/portfolios.ts";
import { SEED_ACCOUNTS } from "../../fixtures/seedData.ts";

// Seed / reset for reproducibility (design §7). `npm run db:seed` builds the
// schema and loads the read-only fixtures; `npm run db:reset` additionally wipes
// the mutable tables so every demo starts from the same pristine state.

async function seedReadOnly(): Promise<void> {
  // Read-only tables can be safely cleared once the mutable (referencing) tables
  // have been truncated.
  await sql`DELETE FROM account`;
  await sql`DELETE FROM portfolio`;

  for (const p of Object.values(PORTFOLIOS)) {
    await sql`
      INSERT INTO portfolio (
        portfolio_id, client_name, type, max_discount_bps,
        max_plan_months, is_pre_legal, discount_ladder_bps
      ) VALUES (
        ${p.portfolioId}, ${p.clientName}, ${p.type}, ${p.maxDiscountBps},
        ${p.maxPlanMonths}, ${p.isPreLegal}, ${p.discountLadderBps}
      )`;
  }

  for (const a of SEED_ACCOUNTS) {
    await sql`
      INSERT INTO account (
        account_ref, first_name, last_name, last4ssn, zip, portfolio_id,
        original_creditor, current_creditor, balance_cents, receive_date,
        flags, state_code
      ) VALUES (
        ${a.accountRef}, ${a.firstName}, ${a.lastName}, ${a.last4ssn}, ${a.zip},
        ${a.portfolioId}, ${a.originalCreditor}, ${a.currentCreditor},
        ${a.balanceCents}, ${a.receiveDate}::date, ${a.flags}, ${a.stateCode}
      )`;
  }
}

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  await createTables();
  await truncateMutable();
  await seedReadOnly();
  console.log(
    `${reset ? "Reset + seeded" : "Seeded"}: ${Object.keys(PORTFOLIOS).length} portfolios, ${SEED_ACCOUNTS.length} accounts. Mutable tables cleared.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
