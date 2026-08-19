# Codebase Areas & Data Model

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers sections 6, 7.

[← Scope & Requirements Traceability](./03-scope-and-traceability.md) · [Index](./README.md) · [API / Backend Changes & Client Flows →](./05-api-and-flows.md)

---

## 6. System / Codebase Areas Affected

The project is greenfield — verified: `/mnt/e/projects/personal/algoritmo-exam` contains only `analysis/`. Nothing is modified; everything is created. Because there is no existing codebase to conform to, **the conventions listed below become a deliverable in themselves** and must hold from the first commit.

### Conventions (binding from commit 1)

1. Feature-module-per-aggregate, not layer-per-type.
2. One entity file per table. `snake_case` in the database via an explicit `name:` on **every** column; `camelCase` in TypeScript.
3. DTOs live in the module's `dto/`. Entities are never returned directly — explicit response mappers keep money-as-string honest and stop TypeORM's in-memory `numeric` quirks from leaking into responses.
4. Services own transactions. Controllers stay thin and never touch a repository.
5. `EntityManager` is passed explicitly as a parameter. No async-local-storage transaction propagation.
6. Every tenant-scoped lookup goes through `TenantScope`.

### Files to create

| Path | Responsibility | Notes |
|---|---|---|
| `src/main.ts` | Bootstrap; global `ValidationPipe` and exception filter | Bind the filter globally here, not per-controller |
| `src/app.module.ts` | TypeORM root config, feature module imports, `TenantMiddleware` binding | Middleware applies to all routes **except** `GET /health` |
| `src/database/data-source.ts` | Single `DataSource` used by both the app and the TypeORM CLI | `synchronize: false` — non-negotiable; explicit migration glob |
| `src/database/migrations/*-Init.ts` | The entire schema, hand-written | Partial unique indexes and `CHECK` constraints need raw SQL; `migration:generate` will not produce them |
| `src/database/migrations/*-SeedOrgs.ts` | Two organizations with fixed UUIDs | Fixed UUIDs so tests and README curl examples can hardcode them |
| `src/common/tenant/tenant.middleware.ts` | Read and validate `X-Org-Id`, attach `req.orgId` | Carries the comment explaining that trusting this header is an assignment-stated assumption, not a real-world practice |
| `src/common/tenant/org-id.decorator.ts` | `@OrgId()` param decorator | Deliberately explicit in every controller signature so a missing tenant scope is visible in review |
| `src/common/tenant/tenant-scope.service.ts` | `findBillOrThrow`, `findBillForUpdateOrThrow`, `findPaymentOrThrow` | **Only** ever throws `NotFoundException`. This is the 404-not-403 invariant, in one file |
| `src/common/money/money.ts` | `normalize`, `negate`, `toMinor` | Trimmed per [T1](./00-critical-review.md). No `add`, no `compare` — SQL does both |
| `src/common/money/is-money-string.validator.ts` | `@IsMoneyString()` | Rejects non-string input outright; this is the float firewall |
| `src/common/filters/all-exceptions.filter.ts` | Uniform `{ statusCode, code, message }` | Never leaks a driver error message to the client |
| `src/common/health/health.controller.ts` | `GET /health` | Exempt from tenant middleware |
| `src/organizations/organization.entity.ts` | `organizations` table | No controller, no service — seeded only |
| `src/bills/bill.entity.ts` | `bills` table | Includes `UNIQUE (org_id, id)`, the composite-FK target |
| `src/bills/bills.service.ts` | `create`, `post`, `void`, `findOne` | Owns two transactions (`post`, `void`) |
| `src/bills/bills.controller.ts` | Four routes | Thin |
| `src/bills/dto/` | `create-bill.dto.ts`, `bill-response.dto.ts` | One shared response DTO for **all** bill-returning endpoints (see [§0.4](./00-critical-review.md)) |
| `src/payments/payment.entity.ts` | `payments` table | `UNIQUE (org_id, external_ref)`, `UNIQUE (org_id, id)` ([C8](./00-critical-review.md)), composite FK to bills |
| `src/payments/payments.service.ts` | `create` (idempotent), `reverse` | The centrepiece of the assessment |
| `src/payments/payments.controller.ts` | Two routes | `create` must be able to return **either** 201 or 200 — use `@Res({ passthrough: true })` or a custom interceptor, not a fixed `@HttpCode` |
| `src/payments/dto/` | `create-payment.dto.ts`, `payment-response.dto.ts` | Response carries `replayed: boolean` and optional `warning` ([C4](./00-critical-review.md)) |
| `src/ledger/ledger-entry.entity.ts` | `ledger_entries` table | **No `deleted_at`, no `@DeleteDateColumn`** ([C2](./00-critical-review.md)) |
| `src/ledger/ledger.service.ts` | `append(manager, …)`, `balanceFor(manager, …)`, `recomputeBillStatus(manager, …)` | The only writer of ledger rows and the only source of a balance |
| `src/llm/llm-client.interface.ts` | `LlmClient { complete(prompt, opts): Promise<string> }` | Injection token `LLM_CLIENT` |
| `src/llm/stub-llm.client.ts` | Deterministic canned-but-realistic JSON | Default binding; the only client the suite exercises |
| `src/llm/anthropic-llm.client.ts` | Real provider behind `LLM_PROVIDER=anthropic` | Timeboxed; never on the test path |
| `src/reconciliation/reconciliation.service.ts` | Parse → shortlist → rank → validate | Zero write access by construction |
| `src/reconciliation/reconciliation.controller.ts` | `POST /reconciliation/suggest` | Never returns 5xx due to a provider failure |
| `test/helpers/{app,db,fixtures}.ts` | Shared harness | One Nest app per spec file; truncate + reseed in `beforeEach` |
| `test/*.e2e-spec.ts` | Six specs | See [§12](./08-testing-plan.md) |
| `README.md`, `DECISIONS.md`, `.env.example`, `.gitignore` | Deliverables | DECISIONS.md is written **last**, from the code that actually exists |

---

## 7. Data Model Changes

Greenfield: every table below is new. One hand-written init migration plus one seed migration.

### `organizations`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `DEFAULT gen_random_uuid()` |
| `name` | `text NOT NULL` | |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz NULL` | Soft-delete requirement; not exercised |

**Why.** The tenant root. No CRUD endpoints — organizations are seeded, per the stated assumption.

### `bills`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `uuid NOT NULL` | FK → `organizations(id)` |
| `amount_due` | `numeric(12,2) NOT NULL` | `CHECK (amount_due > 0)` |
| `status` | `text NOT NULL DEFAULT 'DRAFT'` | `CHECK (status IN ('DRAFT','POSTED','PAID','VOID'))` |
| `posted_at` | `timestamptz NULL` | |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz NULL` | |

- `UNIQUE (org_id, id)` — **the composite-FK target.** Redundant as a uniqueness claim (`id` is already the PK); it exists solely so child tables can reference the pair. Add a migration comment saying exactly that, or a reviewer will read it as a mistake.
- `INDEX (org_id, status)` — supports the AI shortlist query, which filters on both.

**Why a `text` + `CHECK` status rather than a Postgres `enum`.** Adding a value to a PG enum requires `ALTER TYPE`, which is awkward in migrations; `text` + `CHECK` gives identical safety with a trivially editable constraint.

### `payments`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `uuid NOT NULL` | |
| `bill_id` | `uuid NOT NULL` | |
| `amount` | `numeric(12,2) NOT NULL` | `CHECK (amount > 0)` |
| `external_ref` | `varchar(128) NOT NULL` | |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz NULL` | Set on reversal; the only table where soft-delete is actually exercised |

- `FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id)` — a payment cannot reference another tenant's bill. Structural, not conventional.
- `UNIQUE (org_id, external_ref)` named **`payments_org_external_ref_uq`** — the idempotency primitive. **Unconditional**, deliberately *not* partial on `deleted_at IS NULL`: a processor reference identifies one real-world event exactly once, forever. Re-crediting on replay-after-refund is precisely the bug idempotency exists to prevent. The constraint name is load-bearing — the service discriminates on it ([C5](./00-critical-review.md)).
- `UNIQUE (org_id, id)` ([C8](./00-critical-review.md)) — target for the ledger's composite payment FK.
- `INDEX (org_id, bill_id)`.

### `ledger_entries`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `uuid NOT NULL` | |
| `bill_id` | `uuid NOT NULL` | |
| `payment_id` | `uuid NULL` | Null for `BILL_POSTED` |
| `type` | `text NOT NULL` | `CHECK (type IN ('BILL_POSTED','PAYMENT_RECEIVED','PAYMENT_REVERSED'))` |
| `amount` | `numeric(12,2) NOT NULL` | Signed |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |

**No `updated_at`. No `deleted_at`.** ([C2](./00-critical-review.md)) The table is append-only; a soft-delete column that must never be used is a trap, and `@DeleteDateColumn` would silently filter balance queries.

Constraints:

- `FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id)`
- `FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id)` ([C8](./00-critical-review.md))
- `CHECK ((type = 'BILL_POSTED' AND amount > 0 AND payment_id IS NULL) OR (type = 'PAYMENT_RECEIVED' AND amount < 0 AND payment_id IS NOT NULL) OR (type = 'PAYMENT_REVERSED' AND amount > 0 AND payment_id IS NOT NULL))` — ties sign **and** `payment_id` presence to the type. A wrong-signed or orphaned entry is unrepresentable.
- `CREATE UNIQUE INDEX ledger_one_posting_per_bill ON ledger_entries (bill_id) WHERE type = 'BILL_POSTED'` — double-posting a bill is unrepresentable even if the service regresses.
- `CREATE UNIQUE INDEX ledger_one_entry_per_payment_type ON ledger_entries (payment_id, type) WHERE payment_id IS NOT NULL` — at most one credit and one reversal per payment. Double-credit is unrepresentable.
- `INDEX (org_id, bill_id, created_at)` — the balance query's access path.

### Migration requirements

- Written **by hand**, not via `migration:generate`. The generator cannot express partial unique indexes or multi-clause `CHECK` constraints, and a generated migration that silently diverges from the intended schema is a common submission failure.
- `gen_random_uuid()` is built in on Postgres 13+. The brief's setup hint pins `postgres:15`, so **no `pgcrypto` extension is needed** — confirmed, not assumed.
- Seed migration inserts two organizations with **fixed** UUIDs so tests and README examples can reference them literally.
- **Final verification, not optional:** drop the database entirely, run the full migration chain, run the full suite. A migration that only works against an incrementally-built local database is worthless to a reviewer.

**Backward compatibility:** not applicable. Greenfield, no existing data.

---

---

[← Scope & Requirements Traceability](./03-scope-and-traceability.md) · [Index](./README.md) · [API / Backend Changes & Client Flows →](./05-api-and-flows.md)
