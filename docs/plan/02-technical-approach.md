# Technical Approach

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers section 3.

[← Implementation Overview & Business Context](./01-overview-and-context.md) · [Index](./README.md) · [Scope & Requirements Traceability →](./03-scope-and-traceability.md)

---

## 3. Technical Approach

### 3.1 Stack

NestJS + TypeORM + Postgres 15, TypeScript strict, Jest + supertest. Fixed by the assignment; no evaluation needed.

Dependencies held to: `@nestjs/*`, `typeorm`, `pg`, `class-validator`, `class-transformer`, `jest`, `ts-jest`, `supertest`, and optionally `@anthropic-ai/sdk`. **Nothing else.** Every additional dependency is a thing to justify in the interview.

### 3.2 Architecture

Feature-module-per-aggregate — the Nest idiom — not layer-per-type.

```text
src/
  main.ts                                  ValidationPipe, global filter, bootstrap
  app.module.ts                            wiring, TypeORM config, middleware binding
  common/
    tenant/tenant.middleware.ts            parse + validate X-Org-Id → req.orgId
    tenant/org-id.decorator.ts             @OrgId() param decorator
    tenant/tenant-scope.service.ts         findBillOrThrow / findPaymentOrThrow (404 only)
    money/money.ts                         normalize / negate / toMinor
    money/is-money-string.validator.ts     class-validator constraint
    filters/all-exceptions.filter.ts       { statusCode, code, message }
    health/health.controller.ts            GET /health
  database/
    data-source.ts                         shared by app + TypeORM CLI, synchronize:false
    migrations/1700000000000-Init.ts
    migrations/1700000000001-SeedOrgs.ts
  organizations/organization.entity.ts
  bills/      bill.entity.ts  bills.service.ts  bills.controller.ts  bills.module.ts  dto/
  payments/   payment.entity.ts payments.service.ts payments.controller.ts payments.module.ts dto/
  ledger/     ledger-entry.entity.ts ledger.service.ts ledger.module.ts
  llm/        llm-client.interface.ts stub-llm.client.ts anthropic-llm.client.ts llm.module.ts
  reconciliation/ reconciliation.service.ts reconciliation.controller.ts reconciliation.module.ts dto/
test/
  helpers/app.ts  helpers/db.ts  helpers/fixtures.ts
  tenant-isolation.e2e-spec.ts
  idempotency.e2e-spec.ts
  ledger-lifecycle.e2e-spec.ts
  concurrency.e2e-spec.ts
  reconciliation.e2e-spec.ts
  no-forbidden.e2e-spec.ts
```

Dependency direction: `controllers → services → { LedgerService, TenantScope, EntityManager }`. `LedgerService` is the only writer of `ledger_entries` and the only computer of balances. `ReconciliationService` depends on read-only queries and `LlmClient`, and on nothing that writes.

### 3.3 Key decisions

---

**Decision — money is `numeric(12,2)` in Postgres and `string` in TypeScript and JSON. All arithmetic happens in SQL.**

**Reason.** IEEE-754 floats cannot represent `0.10`; JavaScript `number` loses cents at scale. `node-postgres` returns `numeric` as a string by default, so if we simply never register a numeric type parser, exactness is preserved for free from the driver all the way to the JSON response. Doing the aggregation in SQL (`SUM`, and comparisons inside `CASE WHEN`) means no balance value ever enters TypeScript as something that could be compared or added incorrectly.

**Alternative.** `decimal.js` for TypeScript-side arithmetic.
**Why not.** It adds a dependency to perform comparisons Postgres already performs correctly, and the aggregation still has to happen in SQL for the transaction to be atomic. It would be pure surface area.

**Alternative.** `bigint` minor units as the storage type.
**Why not.** The assignment explicitly specifies `numeric(12,2)`. Diverging from an explicit instruction to make an equivalent point is a bad trade in an assessment.

---

**Decision — the ledger stores signed amounts, and `balance = SUM(amount)`.**

**Reason.** This is the highest-leverage decision in the build. It makes "the ledger nets out" a literal, single-query assertion; it makes a reversal an ordinary insert rather than a special case; and it makes the reconciliation test one line. A `CHECK` constraint ties each entry type to its required sign, so a wrong-signed row cannot be written even by buggy code.

**Alternative.** Magnitude plus a type column, with sign applied at read time.
**Why not.** Every consumer then has to reimplement the sign rule. The balance query stops being a `SUM` and becomes a `CASE` expression that has to be kept in sync across the service, the tests, and the AI shortlist query. Three places to get it wrong instead of zero.

---

**Decision — tenant isolation via a single scoped-lookup choke point (`TenantScope.*OrThrow`) plus composite foreign keys in the schema.**

**Reason.** Two independent layers. In code, every tenant-scoped lookup goes through one service whose only failure mode is `NotFoundException` — which makes "404, never 403" a grep-able property rather than a convention. In the schema, `payments(org_id, bill_id) → bills(org_id, id)` and `ledger_entries(org_id, bill_id) → bills(org_id, id)` mean a row that mixes tenants cannot physically be inserted, regardless of what the service layer does.

**Alternative.** Postgres Row-Level Security with `SET LOCAL app.current_org`.
**Why not.** It is the correct answer at scale and I will say so in DECISIONS.md. But it interacts badly with connection pooling unless every request is wrapped in a transaction with the setting applied, and getting that subtly wrong inside a 5-hour budget risks the entire isolation requirement. Naming it as future work earns the judgment credit at zero risk.

**Alternative.** A TypeORM global subscriber that rewrites every query to add `org_id`.
**Why not.** Invisible magic. In a live-extension interview, code the candidate cannot trace on screen is worse than slightly more verbose code they can.

---

**Decision — idempotency is enforced by a unique index; the service inserts first and handles the violation.**

**Reason.** Check-then-insert has a window between the check and the insert, and that window is *exactly* what two simultaneous webhook deliveries occupy. The unique index is the only true serialization point available. On violation (discriminated by constraint name — see [C5](./00-critical-review.md)), the transaction rolls back and a **fresh** transaction re-reads the payment by `(org_id, external_ref)` with `withDeleted: true`, returning 200. The re-read is guaranteed to find the row: our `INSERT` blocks on the index until the competing transaction resolves, so a `23505` means that transaction committed.

**Alternative.** A Redis idempotency cache.
**Why not.** New infrastructure to weakly approximate a guarantee the database already provides strongly. It would also introduce a consistency gap between the cache and the money.

**Alternative.** `SELECT` by `external_ref` and return early if found.
**Why not.** It is the bug being tested for. It would still be needed as a fast path in a high-volume system, but only *in front of* the unique index, never instead of it.

---

**Decision — every money-mutating transaction begins with `SELECT … FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE`.**

**Reason.** The unique index solves duplicate references but says nothing about two *different* payments landing on the same bill simultaneously — both would read the same pre-state and one status update would be lost. The row lock serializes them. A uniform lock order (always the bill, always first) means deadlock is structurally impossible. READ COMMITTED plus this lock is sufficient; SERIALIZABLE would require serialization-failure retry logic for no additional guarantee here.

**Alternative.** SERIALIZABLE isolation.
**Why not.** Every transaction would need a retry wrapper for `40001`, which is more code and more explaining for a guarantee the row lock already delivers.

---

**Decision — reversal appends a compensating entry and soft-deletes the payment; the original entry is never touched.**

**Reason.** This is how correction works in accounting, and it is what makes the ledger auditable. The balance is then recomputed from ledger entries — deliberately **not** filtered by the payment's soft-delete state, because entries are the truth and payments are merely their origin. That line needs a code comment; it is the most likely live-interview question.

**Alternative.** Update or delete the original `PAYMENT_RECEIVED` row.
**Why not.** It destroys the audit trail and violates the "never hard delete" requirement in spirit even where it does not violate it literally.

---

**Decision — the AI slice is a read-only bank-line match suggester.**

**Reason.** The daily pain in utility billing is a cashier facing a list of unmatched bank/GCash lines with ambiguous references. It is genuinely useful, it is the clearest possible case for "suggest, don't act", and it needs zero write access. Amount parsing is deterministic (regex, in code); candidate shortlisting is deterministic (SQL); the model only ranks and writes the human-readable explanation. If the model is unavailable, the cashier still receives a usable shortlist — degradation, not a dead feature.

**Alternative.** An LLM that posts the payment it matched.
**Why not.** It puts a non-deterministic component inside the money path. That is the single worst product decision available here, and recognising that is most of what this part of the assignment is testing.

---

### 3.4 Validation

`class-validator` DTOs with a global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.

- A custom `@IsMoneyString()` constraint accepts `/^\d{1,10}(\.\d{1,2})?$/`, requires a value `> 0`, and **rejects any non-string input** — so `{"amount": 40.5}` is a 400, not a silently coerced float. This is the single most important validator in the build; it is the boundary that keeps floats out of the system.
- **Never** use `@Transform` to coerce a money field to `number`.
- `X-Org-Id` is validated in middleware, before any DTO runs: missing → 400 `MISSING_ORG_CONTEXT`, non-UUID → 400 `INVALID_ORG_CONTEXT`. A well-formed UUID for a non-existent org is *not* a 400 — it produces 404 on every resource lookup, which is the same response another tenant's resource produces. That equivalence is intentional.

### 3.5 Error handling

A global exception filter emits `{ statusCode, code, message }` for everything. It must never echo raw database errors to a client. Business failures map to stable machine-readable codes ([§13](./09-errors-and-security.md)). Cross-tenant access and missing resources produce **byte-identical** responses — that is the anti-enumeration property, and it is worth an explicit assertion in the isolation spec.

### 3.6 Authentication / authorisation

None, by assignment. `X-Org-Id` is trusted as though set by an upstream authenticated gateway. This assumption is stated in the README, in DECISIONS.md, and as a comment in `tenant.middleware.ts` — an untrusted tenant header in real code is a critical vulnerability, and the reviewer needs to see that the candidate knows the difference between "not required here" and "not needed".

### 3.7 External integrations

Anthropic API, optional, behind `LlmClient`, activated only by `LLM_PROVIDER=anthropic`. Default binding is `StubLlmClient`. No key in the repository; `.env.example` only.

---

---

[← Implementation Overview & Business Context](./01-overview-and-context.md) · [Index](./README.md) · [Scope & Requirements Traceability →](./03-scope-and-traceability.md)
