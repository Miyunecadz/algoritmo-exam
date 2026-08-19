import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const LEDGER_ENTRY_TYPES = ['BILL_POSTED', 'PAYMENT_RECEIVED', 'PAYMENT_REVERSED'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * Append-only. There is deliberately NO `deleted_at` and NO `@DeleteDateColumn` on this table:
 * TypeORM's soft-delete column silently adds `deleted_at IS NULL` to reads, which would make the
 * balance query quietly wrong. "Never hard delete" is satisfied here by never deleting at all —
 * a correction is a new, compensating row (`PAYMENT_REVERSED`), never a mutation of an old one.
 *
 * Amounts are signed: BILL_POSTED = +amountDue, PAYMENT_RECEIVED = -amount, PAYMENT_REVERSED =
 * +amount. Therefore `balance = SUM(amount)` — reconciliation is one query, and a reversal needs
 * no special-case arithmetic. A CHECK constraint ties each type to its required sign.
 */
@Entity({ name: 'ledger_entries' })
@Index('ledger_org_bill_created_idx', ['orgId', 'billId', 'createdAt'])
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'org_id' })
  orgId!: string;

  @Column({ type: 'uuid', name: 'bill_id' })
  billId!: string;

  /** Null for `BILL_POSTED`; required for the two payment types. */
  @Column({ type: 'uuid', name: 'payment_id', nullable: true })
  paymentId!: string | null;

  @Column({ type: 'text', name: 'type' })
  type!: LedgerEntryType;

  @Column({ type: 'numeric', precision: 12, scale: 2, name: 'amount' })
  amount!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
