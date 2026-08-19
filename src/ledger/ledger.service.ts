import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { LedgerEntry, LedgerEntryType } from './ledger-entry.entity';

export interface BillBalance {
  /** `SUM(amount)` over the bill's ledger entries. Positive = owed, negative = credit. */
  balance: string;
  /** Net cash currently applied to the bill: `-1 * SUM(payment entries)`. */
  amountPaid: string;
}

export interface AppendLedgerEntryInput {
  orgId: string;
  billId: string;
  paymentId?: string | null;
  type: LedgerEntryType;
  /** Signed money string. The database CHECK constraint rejects the wrong sign for the type. */
  amount: string;
}

/**
 * The only module in the codebase that writes `ledger_entries` or computes a balance.
 *
 * There is deliberately no `update` and no `delete` method here, and none may be added: the ledger
 * is append-only, and a correction is a new compensating row.
 */
@Injectable()
export class LedgerService {
  /** Appends one entry. Always called inside the caller's transaction. */
  async append(manager: EntityManager, input: AppendLedgerEntryInput): Promise<LedgerEntry> {
    const entries = manager.getRepository(LedgerEntry);
    return entries.save(
      entries.create({
        orgId: input.orgId,
        billId: input.billId,
        paymentId: input.paymentId ?? null,
        type: input.type,
        amount: input.amount,
      }),
    );
  }

  /**
   * Balance and applied cash for one bill, in a single round trip.
   *
   * Note what this query does NOT do: it never joins to `payments` and never filters on
   * `payments.deleted_at`. Ledger entries are the truth; payments are merely their origin. A
   * reversal is represented by a compensating `PAYMENT_REVERSED` row, so filtering out
   * soft-deleted payments would drop the original credit while keeping the reversal — silently
   * breaking reconciliation.
   *
   * The `::text` cast makes Postgres, not the client, responsible for the two-decimal formatting.
   */
  async balanceFor(manager: EntityManager, orgId: string, billId: string): Promise<BillBalance> {
    const [row] = await manager.query<{ balance: string; amount_paid: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::numeric(12,2)::text AS balance,
              (-1 * COALESCE(SUM(amount) FILTER (
                 WHERE type IN ('PAYMENT_RECEIVED','PAYMENT_REVERSED')), 0))::numeric(12,2)::text
              AS amount_paid
         FROM ledger_entries
        WHERE bill_id = $1 AND org_id = $2`,
      [billId, orgId],
    );
    return { balance: row.balance, amountPaid: row.amount_paid };
  }

  /**
   * Recomputes the bill status from the ledger, in one statement.
   *
   * No balance value ever crosses into TypeScript for this decision: reading the sum out and
   * branching in JavaScript would be both an extra round trip and an invitation to compare money
   * as a `number`. The `status IN ('POSTED','PAID')` guard keeps a DRAFT or VOID bill out of the
   * recompute entirely — a VOID bill must never be resurrected to POSTED.
   *
   * Called inside the money transaction, after the bill row is locked.
   */
  async recomputeBillStatus(manager: EntityManager, orgId: string, billId: string): Promise<void> {
    await manager.query(
      `UPDATE bills
          SET status = CASE
                WHEN (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
                       WHERE bill_id = $1 AND org_id = $2) <= 0 THEN 'PAID'
                ELSE 'POSTED' END,
              updated_at = now()
        WHERE id = $1 AND org_id = $2 AND status IN ('POSTED','PAID')`,
      [billId, orgId],
    );
  }
}
