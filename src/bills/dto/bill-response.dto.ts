import { BillBalance } from '../../ledger/ledger.service';
import { Bill, BillStatus } from '../bill.entity';
import { Money } from '../../common/money/money';

/**
 * The single response shape for EVERY bill-returning endpoint (create, post, void, get, and the
 * bill embedded in payment responses). One shape means one place where money formatting can be
 * wrong, and no per-endpoint surprises for a client.
 */
export class BillResponseDto {
  id!: string;
  amountDue!: string;
  status!: BillStatus;
  balance!: string;
  amountPaid!: string;
  postedAt!: string | null;
  createdAt!: string;

  static from(bill: Bill, balance: BillBalance): BillResponseDto {
    return {
      id: bill.id,
      // Normalised explicitly: TypeORM returns the in-memory value from `save()` unchanged, so a
      // freshly created entity would otherwise echo back whatever the client sent ("100" not
      // "100.00"). Re-reads come back from the driver already formatted by `numeric(12,2)`.
      amountDue: Money.normalize(bill.amountDue),
      status: bill.status,
      balance: balance.balance,
      amountPaid: balance.amountPaid,
      postedAt: bill.postedAt ? bill.postedAt.toISOString() : null,
      createdAt: bill.createdAt.toISOString(),
    };
  }
}
