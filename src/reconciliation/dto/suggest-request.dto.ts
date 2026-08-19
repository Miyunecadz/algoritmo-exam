import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class SuggestMatchDto {
  /** One raw line copied from a bank / GCash statement. */
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 512)
  rawLine!: string;
}
