import { Body, Controller, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { OrgId } from '../common/tenant/org-id.decorator';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * 201 when the payment was created, 200 when the request was a replay of an `externalRef` that
   * already exists. The status code is therefore set per-request — no fixed `@HttpCode` here.
   */
  @Post()
  async create(
    @OrgId() orgId: string,
    @Body() dto: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentResponseDto> {
    const result = await this.payments.create(orgId, dto);
    res.status(result.created ? 201 : 200);
    return result.payload;
  }

}
