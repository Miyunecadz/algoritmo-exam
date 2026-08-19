import { BillResponseDto } from '../../bills/dto/bill-response.dto';
import { Money } from '../../common/money/money';
import { Payment } from '../payment.entity';

export class PaymentDto {
  id!: string;
  billId!: string;
  amount!: string;
  externalRef!: string;
  createdAt!: string;
  /** Set once the payment has been reversed (its soft-delete timestamp), otherwise null. */
  reversedAt!: string | null;

  static from(payment: Payment): PaymentDto {
    return {
      id: payment.id,
      billId: payment.billId,
      amount: Money.normalize(payment.amount),
      externalRef: payment.externalRef,
      createdAt: payment.createdAt.toISOString(),
      reversedAt: payment.deletedAt ? payment.deletedAt.toISOString() : null,
    };
  }
}

/** Stable codes for a replay whose payload disagrees with what was stored. */
export const ReplayWarning = {
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH_ON_REPLAY',
  BILL_MISMATCH: 'BILL_MISMATCH_ON_REPLAY',
} as const;

export type ReplayWarning = (typeof ReplayWarning)[keyof typeof ReplayWarning];

export class PaymentResponseDto {
  payment!: PaymentDto;
  bill!: BillResponseDto;
  /** True when this request was a replay of an `externalRef` already recorded for the org. */
  replayed!: boolean;
  /**
   * Every disagreement between the replayed payload and the stored payment, e.g.
   * `["AMOUNT_MISMATCH_ON_REPLAY"]`. Advisory only — never changes what was stored, and empty on
   * the ordinary paths. A list rather than one code because a payload can be wrong twice over.
   */
  warnings!: string[];
}
