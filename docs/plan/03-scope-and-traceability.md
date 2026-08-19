# Scope & Requirements Traceability

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers sections 4, 5.

[← Technical Approach](./02-technical-approach.md) · [Index](./README.md) · [Codebase Areas & Data Model →](./04-codebase-and-data-model.md)

---

## 4. Scope

### In Scope

- 4 entities (`organizations`, `bills`, `payments`, `ledger_entries`), a hand-written init migration with all constraints and partial indexes, and a seed migration for two test organizations.
- 6 endpoints: `POST /bills`, `POST /bills/:id/post`, `POST /bills/:id/void`, `GET /bills/:id`, `POST /payments`, `DELETE /payments/:id`. Plus `GET /health` and `POST /reconciliation/suggest`.
- Tenant middleware, `@OrgId()` decorator, `TenantScope` service.
- Money string validator and minimal `Money` helper.
- Transactional services with `FOR UPDATE` bill locking.
- Global `ValidationPipe` and exception filter.
- e2e suite against real Postgres, including a genuine concurrency spec.
- AI reconciliation module behind an interface: stub client (default) plus one real client path.
- README, DECISIONS.md (≤1 page), `.env.example`, conventional commit history.

### Out of Scope

Authentication, JWT, login. Organization CRUD. Users and roles. Invoices, line items, tax. Multi-currency and currency conversion. Refund-to-processor integration. Outbound webhooks. List and pagination endpoints. Rate limiting. Any frontend. A Dockerfile or Docker Compose for the API itself (`docker run` for Postgres is sufficient per the assignment hint). CI pipeline. Observability stack. Event sourcing, outbox pattern, CQRS. Partial reversals. Editing `amountDue` after posting.

### Future Improvements

Named in DECISIONS.md, not built:

1. **Postgres RLS** as the scale answer for tenant isolation.
2. **A denormalized `bills.balance`**, updated inside the same transaction, when ledger volume per bill grows. Deliberately deferred because derived-from-ledger is more provably correct, which is what this exercise is about.
3. **An audit read path** with `withDeleted: true` so an administrator can see reversed payments — the acknowledged cost of the 404-on-soft-deleted rule.
4. `@nestjs/swagger` for interactive API documentation.
5. Partial reversals and multi-currency support.
6. Persisting AI suggestions to an audit table to measure acceptance rate.

---

## 5. Requirements Traceability

> **Verified against the brief** at `docs/assignment.md`. Every one of the brief's five endpoints, five non-negotiables, four required test scenarios, LLM-slice criteria, and deliverables maps to a row below. `F6` (void) and `F8` (health) have no counterpart in the brief — they are deliberate additions, which is why neither is ranked Must.

### Functional

| ID | Requirement | Priority | Implementation Area | Approach | Verification |
|---|---|---|---|---|---|
| F1 | `POST /bills` creates a DRAFT bill scoped to the header org | Must | `bills.controller.ts`, `bills.service.ts` | Insert with `status='DRAFT'`, `orgId` from `@OrgId()`. No ledger rows. | `ledger-lifecycle.e2e-spec` step 1 |
| F2 | `POST /bills/:id/post` transitions DRAFT→POSTED and writes one `BILL_POSTED` entry, atomically | Must | `bills.service.post()` | One transaction: lock bill → assert DRAFT → `LedgerService.append(+amountDue)` → update status + `posted_at` | Lifecycle spec; "post twice → 409, one entry" |
| F3 | `POST /payments` is idempotent on `externalRef`; writes payment + `PAYMENT_RECEIVED` + recomputes status, atomically | Must | `payments.service.create()` | Lock bill → assert POSTED → insert payment (may raise `23505`) → append `−amount` → SQL status recompute. On `payments_org_external_ref_uq`: rollback, fresh-tx re-read `withDeleted`, 200 | `idempotency.e2e-spec`, `concurrency.e2e-spec` |
| F4 | `DELETE /payments/:id` soft-deletes the payment, appends `PAYMENT_REVERSED`, reopens the bill, atomically | Must | `payments.service.reverse()` | Lock bill → re-select payment `FOR UPDATE`, assert `deleted_at IS NULL` → append `+amount` → set `deleted_at` → SQL status recompute (see [C1](./00-critical-review.md)) | Lifecycle spec; double-reverse → 404 |
| F5 | `GET /bills/:id` returns the bill and its current balance | Must | `bills.service.findOne()` | `TenantScope.findBillOrThrow` + `LedgerService.balanceFor()` | Every spec |
| F6 | `POST /bills/:id/void` | Should | `bills.service.void()` | Lock bill → allow DRAFT→VOID, POSTED→VOID only when the bill has zero non-deleted payments → else 409 | Additional cases spec |
| F7 | AI-assisted feature, read-only | Must | `reconciliation/`, `llm/` | Deterministic parse + SQL shortlist; model ranks; `billId` validated against the shortlist | `reconciliation.e2e-spec`, incl. zero-writes assertion |
| F8 | Health endpoint | Nice | `common/health/` | `GET /health` → `{ status: 'ok' }` | Manual / smoke |

### Non-functional

| ID | Requirement | Priority | Implementation Area | Approach | Verification |
|---|---|---|---|---|---|
| N1 | `numeric(12,2)` in DB, `string` in TS and JSON | Must | Entities, DTOs, migration | No pg numeric parser registered (with a comment saying why); explicit response mappers | `typeof === 'string'` and exact-2-decimal assertions in every spec |
| N2 | Every tenant-scoped query filtered by `org_id` | Must | `TenantScope`, composite FKs | Single choke point + schema backstop | `tenant-isolation.e2e-spec` |
| N3 | All multi-row money writes inside one transaction | Must | Services | `dataSource.transaction(manager => …)`, `EntityManager` passed explicitly | Isolation spec asserts zero rows written on a rejected cross-org call |
| N4 | Correct under concurrency | Must | Locking + unique index | `FOR UPDATE` first; unique index on `(org_id, external_ref)` | `concurrency.e2e-spec`, looped |
| N5 | TypeORM migrations, `synchronize: false` | Must | `data-source.ts` | Hand-written init migration | Drop DB → migrate → suite green |
| N6 | No committed secrets | Must | `.gitignore`, `.env.example` | Env only | `git log -p \| grep -i key` before submit |
| N7 | AI call cannot block or corrupt the money path | Must | `reconciliation/`, `llm/` | Separate module and endpoint; `AbortController` 3s timeout; catch-all fallback | Stub-throws test → still 200, `llmAvailable:false` |
| N8 | One-command Postgres, migrate, test | Must | README, npm scripts | `db:up`, `migration:run`, `test:e2e` | Execute the README verbatim on a clean machine |
| N9 | Conventional commits | Must | Git history | Commit at each step boundary | `git log --oneline` |
| N10 | Strict TypeScript, lint clean | Should | `tsconfig`, eslint | `strict: true` | `tsc --noEmit`, `npm run lint` |
| N11 | Structured logging with `orgId`, no amounts | Should | Services | One log line per completed money transaction: `orgId`, `externalRef`, entity id — never amounts | Code review |

### Business rules

| ID | Rule | Enforced where | Verification |
|---|---|---|---|
| B1 | Legal transitions only; anything else 409 | Service, inside the bill lock | Additional cases spec |
| B2 | Sign convention per entry type | DB `CHECK` + `LedgerService` | Migration; lifecycle spec |
| B3 | `balance = SUM(ledger.amount)` for that bill and org | `LedgerService.balanceFor()` | Lifecycle spec asserts the SUM directly against the API value |
| B4 | DRAFT bill has zero entries and balance `"0.00"` | Service; `COALESCE(SUM,0)` | Lifecycle spec step 1 |
| B5 | PAID iff balance ≤ 0 and status was POSTED/PAID | Single SQL `UPDATE … CASE WHEN` ([C7](./00-critical-review.md)) | Lifecycle + overpay specs |
| B6 | One `externalRef` per org ⇒ at most one payment and one credit entry, forever | `UNIQUE (org_id, external_ref)` + partial `UNIQUE (payment_id, type)` | Idempotency + concurrency specs |
| B7 | Reversal never mutates the original credit entry | No `UPDATE` path exists on `ledger_entries` | Lifecycle spec compares the row before/after |
| B8 | Payments accepted only on POSTED bills | Service, inside the lock | Payment-on-DRAFT/VOID → 409 |
| B9 | Payment and bill share `org_id` | Composite FK | Schema; isolation spec |
| B10 | Ledger is append-only | `LedgerService` exposes `append` and `balanceFor` only; no `deleted_at` column ([C2](./00-critical-review.md)) | Code review + grep |
| B11 | Cross-org access is 404, never 403, never 200 | `TenantScope` throws `NotFoundException` exclusively | `no-forbidden.e2e-spec` |
| B12 | The AI path never inserts a payment or ledger entry | Module boundary | `reconciliation.e2e-spec` count assertion |

---

---

[← Technical Approach](./02-technical-approach.md) · [Index](./README.md) · [Codebase Areas & Data Model →](./04-codebase-and-data-model.md)
