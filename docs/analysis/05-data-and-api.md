# 5. Data & API Design

> Part 5 of the [Mini Billing Ledger analysis](./README.md).

## Schema

**organizations**
`id uuid pk default gen_random_uuid()`, `name text not null`, `created_at`, `updated_at`, `deleted_at null`

**bills**
`id uuid pk`, `org_id uuid not null → organizations(id)`, `amount_due numeric(12,2) not null check (amount_due > 0)`, `status text not null check (status in ('DRAFT','POSTED','PAID','VOID')) default 'DRAFT'`, `posted_at timestamptz null`, timestamps, `deleted_at null`

- `UNIQUE (org_id, id)` ← FK target for tenant integrity
- `INDEX (org_id, status)`

**payments**
`id uuid pk`, `org_id uuid not null`, `bill_id uuid not null`, `amount numeric(12,2) not null check (amount > 0)`, `external_ref varchar(128) not null`, timestamps, `deleted_at null`

- `FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id)`
- `UNIQUE (org_id, external_ref)` ← the idempotency primitive
- `INDEX (org_id, bill_id)`

**ledger_entries**
`id uuid pk`, `org_id uuid not null`, `bill_id uuid not null`, `payment_id uuid null → payments(id)`, `type text not null check (type in ('BILL_POSTED','PAYMENT_RECEIVED','PAYMENT_REVERSED'))`, `amount numeric(12,2) not null`, `created_at`, `deleted_at null`

- `FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id)`
- `CHECK ((type='BILL_POSTED' AND amount > 0) OR (type='PAYMENT_RECEIVED' AND amount < 0) OR (type='PAYMENT_REVERSED' AND amount > 0))`
- `UNIQUE (bill_id) WHERE type='BILL_POSTED'` (partial)
- `UNIQUE (payment_id, type) WHERE payment_id IS NOT NULL` (partial)
- `INDEX (org_id, bill_id, created_at)`

Notes:

- Partial unique indexes need raw SQL in the migration — TypeORM decorators won't express them cleanly. Write them explicitly in the migration `up()`.
- `gen_random_uuid()` needs `pgcrypto` on PG < 13; PG 15 per the setup hint has it built in.
- `numeric(12,2)` max ≈ `9,999,999,999.99`.

## API

| Method | Path | Body | 2xx | Errors |
|---|---|---|---|---|
| POST | `/bills` | `{amountDue:"100.00"}` | 201 bill | 400 |
| POST | `/bills/:id/post` | — | 200 bill+balance | 400/404/409 |
| POST | `/bills/:id/void` | — | 200 bill | 404/409 |
| POST | `/payments` | `{billId, amount:"40.00", externalRef}` | 201 new / **200 replay** | 400/404/409 |
| DELETE | `/payments/:id` | — | 200 `{payment, bill}` | 400/404 |
| GET | `/bills/:id` | — | 200 `{id, amountDue, status, balance, amountPaid, postedAt}` | 400/404 |
| POST | `/reconciliation/suggest` | `{rawLine}` | 200 suggestion | 400 |

All requests require `X-Org-Id`. All money fields are strings, always 2 decimals.

Error body: `{ statusCode, code, message }`.
