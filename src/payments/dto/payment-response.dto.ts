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

export class PaymentResponseDto {
  payment!: PaymentDto;
  bill!: BillResponseDto;
  /** True when this request was a replay of an `externalRef` already recorded for the org. */
  replayed!: boolean;
  /** e.g. `AMOUNT_MISMATCH_ON_REPLAY` — advisory only, never changes what was stored. */
  warning!: string | null;
}
