import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ErrorCode } from '../common/errors/error-code';
import { Money } from '../common/money/money';
import { TenantScope } from '../common/tenant/tenant-scope.service';
import { LedgerService } from '../ledger/ledger.service';
import { Bill } from './bill.entity';
import { Payment } from '../payments/payment.entity';
import { BillResponseDto } from './dto/bill-response.dto';
import { CreateBillDto } from './dto/create-bill.dto';

@Injectable()
export class BillsService {
  private readonly logger = new Logger(BillsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly tenantScope: TenantScope,
    private readonly ledger: LedgerService,
  ) {}

  /** A draft is not yet a receivable, so it writes no ledger entry and needs no transaction. */
  async create(orgId: string, dto: CreateBillDto): Promise<BillResponseDto> {
    const repository = this.dataSource.getRepository(Bill);
    const bill = await repository.save(
      repository.create({ orgId, amountDue: Money.normalize(dto.amountDue), status: 'DRAFT' }),
    );

    this.logger.log(`bill.created orgId=${orgId} billId=${bill.id}`);
    return BillResponseDto.from(bill, { balance: '0.00', amountPaid: '0.00' });
  }

  /**
   * DRAFT -> POSTED, writing the `BILL_POSTED` debit in the same transaction.
   *
   * Three layers defend the "post exactly once" invariant, on purpose: the row lock serialises
   * concurrent posts, the in-lock status re-check gives the loser a clean 409, and the partial
   * unique index `ledger_one_posting_per_bill` guarantees the invariant even if a future refactor
   * removes the check. Only the index survives a code regression.
   */
  async post(orgId: string, billId: string): Promise<BillResponseDto> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const bill = await this.tenantScope.findBillForUpdateOrThrow(manager, orgId, billId);

      if (bill.status !== 'DRAFT') {
        throw new ConflictException({
          code: ErrorCode.INVALID_BILL_STATE,
          message: `Bill cannot be posted from status ${bill.status}`,
        });
      }

      await this.ledger.append(manager, {
        orgId,
        billId: bill.id,
        type: 'BILL_POSTED',
        amount: Money.normalize(bill.amountDue),
      });

      await manager.query(
        `UPDATE bills SET status = 'POSTED', posted_at = now(), updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [bill.id, orgId],
      );

      const posted = await this.tenantScope.findBillOrThrow(manager, orgId, billId);
      const balance = await this.ledger.balanceFor(manager, orgId, billId);

      this.logger.log(`bill.posted orgId=${orgId} billId=${billId} status=${posted.status}`);
      return BillResponseDto.from(posted, balance);
    });
  }

  /**
   * Completes the state machine — VOID has no other route to reach it.
   *
   * A voided POSTED bill keeps its `BILL_POSTED` entry and therefore its balance. Writing a
   * reversing entry instead would need a fourth entry type; voiding is only permitted while no
   * money has moved, so the two readings never disagree in practice. Documented in DECISIONS.md.
   */
  async void(orgId: string, billId: string): Promise<BillResponseDto> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const bill = await this.tenantScope.findBillForUpdateOrThrow(manager, orgId, billId);

      if (bill.status !== 'DRAFT' && bill.status !== 'POSTED') {
        throw new ConflictException({
          code: ErrorCode.INVALID_BILL_STATE,
          message: `Bill cannot be voided from status ${bill.status}`,
        });
      }

      if (bill.status === 'POSTED') {
        const activePayments = await manager.getRepository(Payment).count({
          where: { orgId, billId: bill.id },
        });
        if (activePayments > 0) {
          throw new ConflictException({
            code: ErrorCode.BILL_HAS_PAYMENTS,
            message: 'Bill cannot be voided while it has payments',
          });
        }
      }

      await manager.query(
        `UPDATE bills SET status = 'VOID', updated_at = now() WHERE id = $1 AND org_id = $2`,
        [bill.id, orgId],
      );

      const voided = await this.tenantScope.findBillOrThrow(manager, orgId, billId);
      const balance = await this.ledger.balanceFor(manager, orgId, billId);

      this.logger.log(`bill.voided orgId=${orgId} billId=${billId}`);
      return BillResponseDto.from(voided, balance);
    });
  }

  async findOne(orgId: string, billId: string): Promise<BillResponseDto> {
    const manager = this.dataSource.manager;
    const bill = await this.tenantScope.findBillOrThrow(manager, orgId, billId);
    const balance = await this.ledger.balanceFor(manager, orgId, billId);
    return BillResponseDto.from(bill, balance);
  }
}
