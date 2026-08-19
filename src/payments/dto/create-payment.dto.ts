import { IsString, IsUUID, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsMoneyString } from '../../common/money/is-money-string.validator';

export class CreatePaymentDto {
  @IsUUID()
  billId!: string;

  /** Decimal string, e.g. `"40.00"`. A JSON number is a 400 — see `IsMoneyString`. */
  @IsMoneyString()
  amount!: string;

  /** The payment processor's id. Idempotency is keyed on `(orgId, externalRef)`. */
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 128)
  externalRef!: string;
}
