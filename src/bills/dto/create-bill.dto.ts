import { IsMoneyString } from '../../common/money/is-money-string.validator';

export class CreateBillDto {
  /** Decimal string, e.g. `"100.00"`. A JSON number is rejected with a 400. */
  @IsMoneyString()
  amountDue!: string;
}
