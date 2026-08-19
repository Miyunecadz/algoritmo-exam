import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Name of the unique index that makes ingestion idempotent. Load-bearing: `PaymentsService`
 *  discriminates on this exact constraint name when handling a 23505, so that any *other* unique
 *  violation surfaces as a 500 rather than being mistaken for a replay. */
export const PAYMENTS_ORG_EXTERNAL_REF_UQ = 'payments_org_external_ref_uq';

@Entity({ name: 'payments' })
@Index('payments_org_bill_idx', ['orgId', 'billId'])
export class Payment {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'org_id' })
  orgId!: string;

  @Column({ type: 'uuid', name: 'bill_id' })
  billId!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, name: 'amount' })
  amount!: string;

  /** The payment processor's id. Unique per organization — see the migration for why. */
  @Column({ type: 'varchar', length: 128, name: 'external_ref' })
  externalRef!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  /** Set on reversal. The only table where soft-delete is actually exercised. */
  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at', nullable: true })
  deletedAt!: Date | null;
}
