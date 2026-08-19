import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The whole schema, hand-written.
 *
 * It is hand-written rather than generated because the correctness of this system lives in the
 * constraints: partial unique indexes and multi-clause CHECKs cannot be expressed by TypeORM
 * decorators, and `migration:generate` would silently drop them.
 */
export class Init1700000000000 implements MigrationInterface {
  name = 'Init1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // gen_random_uuid() is built into Postgres 13+. The extension keeps this migration working on
    // older servers as well, and is a no-op on 13+.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await queryRunner.query(`
      CREATE TABLE organizations (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE bills (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id     uuid NOT NULL REFERENCES organizations (id),
        amount_due numeric(12,2) NOT NULL,
        status     text NOT NULL DEFAULT 'DRAFT',
        posted_at  timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        CONSTRAINT bills_amount_due_positive_chk CHECK (amount_due > 0),
        CONSTRAINT bills_status_chk CHECK (status IN ('DRAFT','POSTED','PAID','VOID'))
      )
    `);

    // Redundant as a uniqueness claim — `id` is already the primary key — but it is the target the
    // child tables' composite foreign keys need, so that a row can never mix two tenants.
    await queryRunner.query(`ALTER TABLE bills ADD CONSTRAINT bills_org_id_uq UNIQUE (org_id, id)`);
    await queryRunner.query(`CREATE INDEX bills_org_status_idx ON bills (org_id, status)`);

    await queryRunner.query(`
      CREATE TABLE payments (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id       uuid NOT NULL REFERENCES organizations (id),
        bill_id      uuid NOT NULL,
        amount       numeric(12,2) NOT NULL,
        external_ref varchar(128) NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        deleted_at   timestamptz NULL,
        CONSTRAINT payments_amount_positive_chk CHECK (amount > 0),
        -- A payment can only ever point at a bill belonging to the same organization. Tenant
        -- integrity is structural here, not a convention the service layer has to remember.
        CONSTRAINT payments_org_bill_fk FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id)
      )
    `);

    // The idempotency primitive. Deliberately UNCONDITIONAL — not partial on `deleted_at IS NULL`:
    // a processor reference identifies one real-world event exactly once, forever. Re-crediting a
    // replay that arrives after a reversal is precisely the bug idempotency exists to prevent.
    // The constraint NAME is load-bearing: PaymentsService discriminates 23505 errors on it.
    await queryRunner.query(
      `ALTER TABLE payments ADD CONSTRAINT payments_org_external_ref_uq UNIQUE (org_id, external_ref)`,
    );
    // Composite-FK target for ledger_entries.payment_id (same tenant-integrity trick as bills).
    await queryRunner.query(
      `ALTER TABLE payments ADD CONSTRAINT payments_org_id_uq UNIQUE (org_id, id)`,
    );
    await queryRunner.query(`CREATE INDEX payments_org_bill_idx ON payments (org_id, bill_id)`);

    await queryRunner.query(`
      CREATE TABLE ledger_entries (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id     uuid NOT NULL REFERENCES organizations (id),
        bill_id    uuid NOT NULL,
        payment_id uuid NULL,
        type       text NOT NULL,
        amount     numeric(12,2) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ledger_type_chk CHECK (type IN ('BILL_POSTED','PAYMENT_RECEIVED','PAYMENT_REVERSED')),
        -- Ties the sign AND the presence of payment_id to the entry type. A wrong-signed or
        -- orphaned entry is unrepresentable, even if the service layer regresses.
        CONSTRAINT ledger_type_amount_sign_chk CHECK (
          (type = 'BILL_POSTED'      AND amount > 0 AND payment_id IS NULL) OR
          (type = 'PAYMENT_RECEIVED' AND amount < 0 AND payment_id IS NOT NULL) OR
          (type = 'PAYMENT_REVERSED' AND amount > 0 AND payment_id IS NOT NULL)
        ),
        CONSTRAINT ledger_org_bill_fk    FOREIGN KEY (org_id, bill_id)    REFERENCES bills (org_id, id),
        CONSTRAINT ledger_org_payment_fk FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id)
      )
    `);

    // A bill can be posted at most once, and a payment can be credited at most once and reversed at
    // most once — enforced by the database, not by the service layer.
    await queryRunner.query(
      `CREATE UNIQUE INDEX ledger_one_posting_per_bill ON ledger_entries (bill_id) WHERE type = 'BILL_POSTED'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX ledger_one_entry_per_payment_type ON ledger_entries (payment_id, type) WHERE payment_id IS NOT NULL`,
    );
    // Access path for the balance query.
    await queryRunner.query(
      `CREATE INDEX ledger_org_bill_created_idx ON ledger_entries (org_id, bill_id, created_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ledger_entries`);
    await queryRunner.query(`DROP TABLE IF EXISTS payments`);
    await queryRunner.query(`DROP TABLE IF EXISTS bills`);
    await queryRunner.query(`DROP TABLE IF EXISTS organizations`);
  }
}
