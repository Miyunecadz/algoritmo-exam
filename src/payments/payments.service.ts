import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { ErrorCode } from '../common/errors/error-code';
import { Money } from '../common/money/money';
import { TenantScope } from '../common/tenant/tenant-scope.service';
import { BillResponseDto } from '../bills/dto/bill-response.dto';
import { LedgerService } from '../ledger/ledger.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentDto, PaymentResponseDto } from './dto/payment-response.dto';
import { Payment, PAYMENTS_ORG_EXTERNAL_REF_UQ } from './payment.entity';

const UNIQUE_VIOLATION = '23505';

/** Result of an ingest: `created` decides whether the controller answers 201 or 200. */
export interface IngestResult {
  created: boolean;
  payload: PaymentResponseDto;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly tenantScope: TenantScope,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Idempotent ingestion, keyed on `(org_id, external_ref)`.
   *
   * The unique index — not application logic — is what makes this safe. A `SELECT` by
   * `external_ref` followed by an `INSERT` has a window between the two statements, and that window
   * is exactly where two simultaneous webhook deliveries from the processor live. So we insert
   * first and let the database arbitrate.
   */
  async create(orgId: string, dto: CreatePaymentDto): Promise<IngestResult> {
    try {
      const payload = await this.dataSource.transaction(async (manager: EntityManager) => {
        // 1. Lock the bill first — always, in every money transaction (uniform lock order).
        const bill = await this.tenantScope.findBillForUpdateOrThrow(manager, orgId, dto.billId);

        // 2. Re-check the status inside the lock.
        if (bill.status !== 'POSTED') {
          throw new ConflictException({
            code: ErrorCode.INVALID_BILL_STATE,
            message: `Payments are only accepted on POSTED bills, this bill is ${bill.status}`,
          });
        }

        const amount = Money.normalize(dto.amount);

        // 3. Insert the payment. May raise 23505 on `payments_org_external_ref_uq`.
        const payment = await manager.getRepository(Payment).save(
          manager.getRepository(Payment).create({
            orgId,
            billId: bill.id,
            amount,
            externalRef: dto.externalRef,
          }),
        );

        // 4. Credit the ledger. Negative by convention, enforced by a CHECK constraint.
        await this.ledger.append(manager, {
          orgId,
          billId: bill.id,
          paymentId: payment.id,
          type: 'PAYMENT_RECEIVED',
          amount: Money.negate(amount),
        });

        // 5. Recompute the status from the ledger, in SQL. No balance enters TypeScript.
        await this.ledger.recomputeBillStatus(manager, orgId, bill.id);

        const refreshed = await this.tenantScope.findBillOrThrow(manager, orgId, bill.id);
        const balance = await this.ledger.balanceFor(manager, orgId, bill.id);

        return {
          payment: PaymentDto.from(payment),
          bill: BillResponseDto.from(refreshed, balance),
          replayed: false,
          warning: null,
        } satisfies PaymentResponseDto;
      });

      this.logger.log(
        `payment.created orgId=${orgId} billId=${dto.billId} externalRef=${dto.externalRef}`,
      );
      return { created: true, payload };
    } catch (error) {
      if (!this.isReplayViolation(error)) throw error;

      // The transaction above has already been rolled back, and it had to be: Postgres aborts a
      // transaction on error and rejects every subsequent statement in it, so the replay cannot be
      // resolved inline. `resolveReplay` therefore runs on a fresh connection state.
      //
      // The re-read is guaranteed to find the row: our INSERT blocked on the unique index until the
      // competing transaction resolved, so a 23505 means that transaction committed.
      const payload = await this.resolveReplay(orgId, dto);

      this.logger.log(
        `payment.replayed orgId=${orgId} externalRef=${dto.externalRef} warning=${payload.warning ?? 'none'}`,
      );
      return { created: false, payload };
    }
  }

  /**
   * Reverses a payment: appends a compensating entry, soft-deletes the payment, reopens the bill.
   *
   * The original `PAYMENT_RECEIVED` entry is never read, updated or deleted — that is what keeps
   * the books auditable, and it is why the balance can still be recomputed as a plain SUM.
   */
  async reverse(orgId: string, paymentId: string): Promise<PaymentResponseDto> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      // 1. Resolve which bill to lock. Scoped to the org, so another tenant gets a 404 here.
      const unlocked = await this.tenantScope.findPaymentOrThrow(manager, orgId, paymentId);

      // 2. Lock the bill first — same order as every other money transaction, so no deadlock.
      const bill = await this.tenantScope.findBillForUpdateOrThrow(manager, orgId, unlocked.billId);

      // 3. Re-select the payment FOR UPDATE and re-check `deleted_at IS NULL` INSIDE the bill lock.
      //    Without this, two concurrent reversals both pass the check in step 1 and collide on the
      //    partial unique index as a 500. With it, the loser gets a clean 404: a reversed payment
      //    is soft-deleted, and soft-deleted rows are invisible to the tenant.
      const payment = await this.tenantScope.findPaymentForUpdateOrThrow(manager, orgId, paymentId);

      // 4. Compensating entry. Positive, carries the same payment_id as the original credit.
      await this.ledger.append(manager, {
        orgId,
        billId: bill.id,
        paymentId: payment.id,
        type: 'PAYMENT_REVERSED',
        amount: Money.normalize(payment.amount),
      });

      // 5. Soft-delete. Never a hard delete.
      await manager.getRepository(Payment).softDelete({ id: payment.id, orgId });

      // 6. Recompute from the ledger — not from a stored balance, and not from payment rows.
      await this.ledger.recomputeBillStatus(manager, orgId, bill.id);

      const reversed = await this.tenantScope.findPaymentOrThrow(manager, orgId, payment.id, {
        withDeleted: true,
      });
      const refreshed = await this.tenantScope.findBillOrThrow(manager, orgId, bill.id);
      const balance = await this.ledger.balanceFor(manager, orgId, bill.id);

      this.logger.log(
        `payment.reversed orgId=${orgId} billId=${bill.id} paymentId=${payment.id} status=${refreshed.status}`,
      );

      return {
        payment: PaymentDto.from(reversed),
        bill: BillResponseDto.from(refreshed, balance),
        replayed: false,
        warning: null,
      };
    });
  }

  /**
   * Only a violation of `payments_org_external_ref_uq` means "replay".
   *
   * The ledger's partial unique indexes raise 23505 too, and treating one of those as a replay
   * would turn a genuine double-credit bug into a cheerful 200. Any other unique violation is an
   * invariant breach and must surface loudly as a 500.
   */
  private isReplayViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = (error as QueryFailedError & { driverError?: unknown }).driverError;
    const details = (driverError ?? error) as { code?: string; constraint?: string };
    return details.code === UNIQUE_VIOLATION && details.constraint === PAYMENTS_ORG_EXTERNAL_REF_UQ;
  }

  /**
   * Resolves a replay in a brand-new transaction.
   *
   * `withDeleted: true` is deliberate: a replay that arrives after the payment was reversed must
   * resolve to the reversed payment rather than 404 — and must certainly not create a second
   * credit. The unique index is unconditional for the same reason: a processor reference names one
   * real-world event exactly once, forever.
   */
  private async resolveReplay(orgId: string, dto: CreatePaymentDto): Promise<PaymentResponseDto> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const existing = await manager.getRepository(Payment).findOne({
        where: { orgId, externalRef: dto.externalRef },
        withDeleted: true,
      });

      if (!existing) {
        // Unreachable: a 23505 on this constraint means the competing transaction committed.
        throw new Error(
          `Replay of externalRef ${dto.externalRef} could not be resolved for org ${orgId}`,
        );
      }

      const bill = await this.tenantScope.findBillOrThrow(manager, orgId, existing.billId);
      const balance = await this.ledger.balanceFor(manager, orgId, existing.billId);

      // A replay whose amount differs from what was stored is an upstream bug worth surfacing.
      // We still return 200 with the original payment — silently ignoring the mismatch would hide
      // the bug, and a 409 would break the idempotency contract the processor relies on.
      const warning = Money.equals(existing.amount, dto.amount)
        ? null
        : 'AMOUNT_MISMATCH_ON_REPLAY';

      return {
        payment: PaymentDto.from(existing),
        bill: BillResponseDto.from(bill, balance),
        replayed: true,
        warning,
      };
    });
  }
}
