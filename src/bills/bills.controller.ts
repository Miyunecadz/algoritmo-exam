import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { OrgId } from '../common/tenant/org-id.decorator';
import { BillsService } from './bills.service';
import { BillResponseDto } from './dto/bill-response.dto';
import { CreateBillDto } from './dto/create-bill.dto';

/** Thin by design: controllers never touch a repository, and services own every transaction. */
@Controller('bills')
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @Post()
  create(@OrgId() orgId: string, @Body() dto: CreateBillDto): Promise<BillResponseDto> {
    return this.bills.create(orgId, dto);
  }

  @Post(':id/post')
  @HttpCode(HttpStatus.OK)
  post(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string): Promise<BillResponseDto> {
    return this.bills.post(orgId, id);
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  void(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string): Promise<BillResponseDto> {
    return this.bills.void(orgId, id);
  }

  @Get(':id')
  findOne(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BillResponseDto> {
    return this.bills.findOne(orgId, id);
  }
}
