import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Bill } from '../../bills/bill.entity';
import { Payment } from '../../payments/payment.entity';
import { ErrorCode } from '../errors/error-code';

/**
 * The single choke point for every tenant-scoped lookup.
 *
 * Two properties make this file the whole of the isolation strategy in code:
 *
 *  1. Every lookup is filtered by `org_id`. There is no unscoped `findById` anywhere in the
 *     codebase, so there is no way to forget the clause.
 *  2. The ONLY failure mode is `NotFoundException`. This file must never import or throw
 *     `ForbiddenException` — a 403 on another tenant's resource would confirm that the resource
 *     exists, which is exactly the leak we are avoiding. "404, never 403" is therefore a
 *     grep-able property of one file rather than a convention spread across services.
 *
 * The database backs this up independently: composite foreign keys mean a row that mixes two
 * tenants cannot physically be inserted, whatever the service layer does.
 */
@Injectable()
export class TenantScope {
  private notFound(resource: string): never {
    // Identical shape for "does not exist" and "belongs to someone else" — deliberately.
    throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: `${resource} not found` });
  }

  async findBillOrThrow(manager: EntityManager, orgId: string, billId: string): Promise<Bill> {
    const bill = await manager.getRepository(Bill).findOne({ where: { id: billId, orgId } });
    return bill ?? this.notFound('Bill');
  }

  /**
   * `SELECT … FOR UPDATE`. This is the first statement of every money-mutating transaction:
   * the unique index on `(org_id, external_ref)` serialises duplicate references, and this lock
   * serialises everything else that touches one bill (two different payments, a concurrent post,
   * a concurrent reversal). Always the bill, always first — a uniform lock order makes deadlock
   * structurally impossible.
   */
  async findBillForUpdateOrThrow(
    manager: EntityManager,
    orgId: string,
    billId: string,
  ): Promise<Bill> {
    const bill = await manager
      .getRepository(Bill)
      .createQueryBuilder('bill')
      .setLock('pessimistic_write')
      .where('bill.id = :billId', { billId })
      .andWhere('bill.org_id = :orgId', { orgId })
      .andWhere('bill.deleted_at IS NULL')
      .getOne();
    return bill ?? this.notFound('Bill');
  }

  async findPaymentOrThrow(
    manager: EntityManager,
    orgId: string,
    paymentId: string,
    opts: { withDeleted?: boolean } = {},
  ): Promise<Payment> {
    const payment = await manager.getRepository(Payment).findOne({
      where: { id: paymentId, orgId },
      withDeleted: opts.withDeleted ?? false,
    });
    return payment ?? this.notFound('Payment');
  }

  /** Re-reads a payment `FOR UPDATE`, used inside the bill lock during reversal. */
  async findPaymentForUpdateOrThrow(
    manager: EntityManager,
    orgId: string,
    paymentId: string,
  ): Promise<Payment> {
    const payment = await manager
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .setLock('pessimistic_write')
      .where('payment.id = :paymentId', { paymentId })
      .andWhere('payment.org_id = :orgId', { orgId })
      .andWhere('payment.deleted_at IS NULL')
      .getOne();
    return payment ?? this.notFound('Payment');
  }
}
