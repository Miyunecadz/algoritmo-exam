import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { OrgId } from '../common/tenant/org-id.decorator';
import { SuggestMatchDto } from './dto/suggest-request.dto';
import { SuggestMatchResponseDto } from './dto/suggest-response.dto';
import { ReconciliationService } from './reconciliation.service';

@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  /** Read-only. Nothing here moves money — the cashier does that with POST /payments. */
  @Post('suggest')
  @HttpCode(HttpStatus.OK)
  suggest(@OrgId() orgId: string, @Body() dto: SuggestMatchDto): Promise<SuggestMatchResponseDto> {
    return this.reconciliation.suggest(orgId, dto.rawLine);
  }
}
