import { store } from "./db/store.ts";

// Thin typed wrapper over the append-only audit_event table (design §14). Every
// decision the orchestrator makes writes one record — the compliance evidence
// chain. Amounts in cents, discounts in bps.

export type AuditEventName =
  | "CONSENT_GIVEN"
  | "AUTH_ATTEMPT"
  | "AUTH_SUCCESS"
  | "AUTH_FAILED"
  | "DISCLOSURE_GIVEN"
  | "SETTLEMENT_PROPOSED"
  | "PLAN_PROPOSED"
  | "OFFER_ACCEPTED"
  | "FC_STARTED"
  | "FC_COMPLETED"
  | "FC_DECLINED"
  | "FC_ABANDONED"
  | "ESCALATED"
  | "OUTPUT_BLOCKED"
  | "CLARIFY"
  | "QUESTION_ANSWERED";

export async function audit(
  sessionId: string,
  event: AuditEventName,
  opts: {
    accountRef?: string | null;
    detail?: Record<string, unknown>;
    reason?: string;
    fsmStateAtEvent?: string;
  } = {},
): Promise<void> {
  await store.appendAudit({
    sessionId,
    accountRef: opts.accountRef ?? null,
    event,
    detail: opts.detail,
    reason: opts.reason,
    fsmStateAtEvent: opts.fsmStateAtEvent,
  });
}
