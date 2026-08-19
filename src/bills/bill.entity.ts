import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const BILL_STATUSES = ['DRAFT', 'POSTED', 'PAID', 'VOID'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

@Entity({ name: 'bills' })
@Index('bills_org_status_idx', ['orgId', 'status'])
export class Bill {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'org_id' })
  orgId!: string;

  /**
   * Money: `numeric(12,2)` in Postgres, `string` in TypeScript and JSON. Never a `number`.
   */
  @Column({ type: 'numeric', precision: 12, scale: 2, name: 'amount_due' })
  amountDue!: string;

  @Column({ type: 'text', name: 'status', default: 'DRAFT' })
  status!: BillStatus;

  @Column({ type: 'timestamptz', name: 'posted_at', nullable: true })
  postedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at', nullable: true })
  deletedAt!: Date | null;
}
