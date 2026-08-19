# Developer Task Breakdown

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers section 11.

[← Detailed Step-by-Step Implementation Plan](./06-implementation-steps.md) · [Index](./README.md) · [Testing Plan →](./08-testing-plan.md)

---

## 11. Developer Task Breakdown

### Configuration

**TASK-001 — Project scaffold and database configuration**
*Objective:* a booting application with a working `DataSource`.
*Changes:* `nest new`, strict `tsconfig`, `.env`/`.env.example`/`.gitignore`, `data-source.ts`, npm scripts.
*Dependencies:* none.
*Files:* `src/main.ts`, `src/app.module.ts`, `src/database/data-source.ts`, `package.json`, `.env.example`, `.gitignore`.
*Acceptance:* `synchronize: false`; `.env` is gitignored **before** the first commit; pool `max ≥ 5`; a comment records why no numeric parser is registered.
*Verification:* `npm run start:dev` connects.

### Database

**TASK-002 — Entities**
*Objective:* four entities mirroring [§7](./04-codebase-and-data-model.md) exactly.
*Changes:* explicit `name:` on every column; money columns typed `string`; `@DeleteDateColumn` on organizations, bills, payments; **none on `LedgerEntry`**.
*Dependencies:* TASK-001.
*Files:* `src/{organizations,bills,payments,ledger}/*.entity.ts`.
*Acceptance:* no money field is typed `number` anywhere; `LedgerEntry` has no `deleted_at`.
*Verification:* `npm run typecheck`.

**TASK-003 — Init migration**
*Objective:* the full schema with every constraint.
*Changes:* hand-written raw SQL: tables, checks, composite unique targets, composite foreign keys, `payments_org_external_ref_uq`, two partial unique indexes, supporting indexes, and a working `down()`.
*Dependencies:* TASK-002.
*Files:* `src/database/migrations/*-Init.ts`.
*Acceptance:* a negative `BILL_POSTED`, a second `BILL_POSTED` for one bill, and a cross-tenant payment insert are each rejected by the database.
*Verification:* run all three by hand in `psql`.

**TASK-004 — Seed migration**
*Objective:* two organizations with fixed UUIDs.
*Dependencies:* TASK-003.
*Files:* `src/database/migrations/*-SeedOrgs.ts`.
*Acceptance:* UUIDs are literals, reusable from tests and the README.
*Verification:* `SELECT * FROM organizations` returns two rows.

### Backend — common

**TASK-005 — Money helper and validator**
*Objective:* the string-money boundary.
*Changes:* `normalize`, `negate`, `toMinor`; `@IsMoneyString()`.
*Dependencies:* TASK-001.
*Files:* `src/common/money/*`.
*Acceptance:* a JSON number is rejected; `"0.1"` normalizes to `"0.10"`; `"40.555"`, `"0"`, and `"-5.00"` are rejected.
*Verification:* `money.spec.ts` green.

**TASK-006 — Tenant middleware, decorator, scope, exception filter**
*Objective:* isolation by construction plus a uniform error shape.
*Dependencies:* TASK-003, TASK-005.
*Files:* `src/common/tenant/*`, `src/common/filters/all-exceptions.filter.ts`, `src/common/health/*`.
*Acceptance:* `TenantScope` never imports `ForbiddenException`; missing header → 400; valid-but-unknown org → 404 on every resource; the filter never echoes a driver message.
*Verification:* curl both header failure cases.

### Backend — domain

**TASK-007 — LedgerService**
*Objective:* the single writer and the single balance source.
*Changes:* `append`, `balanceFor` (returns `balance` and `amountPaid` in one query), `recomputeBillStatus` (one `UPDATE … CASE WHEN`, guarded to `POSTED`/`PAID`).
*Dependencies:* TASK-006.
*Files:* `src/ledger/*`.
*Acceptance:* no update or delete method exists; `balanceFor` does not reference `payments`; no balance value is compared in TypeScript.
*Verification:* exercised by TASK-008.

**TASK-008 — Bills: create, post, void, get**
*Objective:* the bill lifecycle and the transaction pattern.
*Dependencies:* TASK-007.
*Files:* `src/bills/*`.
*Acceptance:* `post` is transactional, locks first, and rejects a non-DRAFT bill with 409; `void` rejects a POSTED bill that has payments; all four endpoints return one shared `BillResponseDto`.
*Verification:* the curl walkthrough from Step 5.

**TASK-009 — Payments: idempotent ingestion**
*Objective:* the centrepiece.
*Changes:* transaction 1; `23505` narrowed by constraint name; fresh-transaction replay re-read with `withDeleted`; `replayed` and `warning` fields; controller sets 201 or 200 dynamically.
*Dependencies:* TASK-008.
*Files:* `src/payments/*`.
*Acceptance:* one payment and one credit entry per `(org, externalRef)`, forever; a non-`payments_org_external_ref_uq` `23505` propagates rather than being swallowed; no fixed `@HttpCode` on the route.
*Verification:* curl the same body twice → 201 then 200.

**TASK-010 — Payments: reversal**
*Objective:* auditable correction.
*Changes:* [§8.5](./05-api-and-flows.md) with the corrected lock ordering; soft-delete; status recompute.
*Dependencies:* TASK-009.
*Files:* `src/payments/payments.service.ts`, `payments.controller.ts`.
*Acceptance:* the payment is re-selected `FOR UPDATE` and re-checked **inside** the bill lock; a second reversal returns 404, not 500; the original credit row is byte-identical afterwards.
*Verification:* the ledger query from Step 7.

### Backend — AI slice

**TASK-011 — LLM client interface, stub, and provider**
*Objective:* a swappable, timeout-bounded client.
*Dependencies:* TASK-001.
*Files:* `src/llm/*`.
*Acceptance:* the stub is the default binding; the real client is reachable only via `LLM_PROVIDER=anthropic`; no key in the repository.
*Verification:* boot with each value of `LLM_PROVIDER`.

**TASK-012 — Reconciliation suggestion endpoint**
*Objective:* read-only matching help.
*Changes:* regex parse; the single shortlist query; prompt; response validation including `billId ∈ shortlist`; 3s abort with fallback.
*Dependencies:* TASK-008, TASK-011.
*Files:* `src/reconciliation/*`.
*Acceptance:* zero write dependencies injected; never 5xx from a provider failure; an out-of-shortlist `billId` is dropped.
*Verification:* TASK-016.

### Testing

**TASK-013 — Test harness**
*Objective:* a deterministic, genuinely concurrent harness.
*Changes:* `globalSetup` migrations against `billing_test`; truncate-and-reseed in `beforeEach`; `app.listen(0)`; `--runInBand`.
*Dependencies:* TASK-004.
*Files:* `test/helpers/*`, `test/jest-e2e.json`.
*Acceptance:* specs pass in any order; the pool allows ≥ 5 concurrent connections.
*Verification:* run the suite twice.

**TASK-014 — Isolation, idempotency, and lifecycle specs**
*Dependencies:* TASK-010, TASK-013.
*Files:* `test/{tenant-isolation,idempotency,ledger-lifecycle}.e2e-spec.ts`.
*Acceptance:* the isolation spec asserts **row counts unchanged**, not merely the 404; the lifecycle spec asserts `SUM(amount)` directly against the API's balance and that every money field is an exact two-decimal string.
*Verification:* `npm run test:e2e`.

**TASK-015 — Concurrency spec**
*Dependencies:* TASK-014.
*Files:* `test/concurrency.e2e-spec.ts`.
*Acceptance:* both cases present — same reference (proves the unique index) and two different references on one bill (proves the lock); the same-reference case is looped ≥ 5 times over fresh references; both status codes are observed.
*Verification:* five consecutive suite runs, no flake.

**TASK-016 — Reconciliation and no-Forbidden specs**
*Dependencies:* TASK-012, TASK-013.
*Files:* `test/reconciliation.e2e-spec.ts`, `test/no-forbidden.e2e-spec.ts`.
*Acceptance:* payment and ledger counts are unchanged across every suggest call; no endpoint ever returns 403 for a cross-tenant request.
*Verification:* `npm run test:e2e`.

### Documentation

**TASK-017 — Fresh-database verification, README, DECISIONS**
*Objective:* it runs on the reviewer's machine, and the reasoning is legible.
*Changes:* drop the database, migrate, run the suite; then write the documentation.
*Dependencies:* all.
*Files:* `README.md`, `DECISIONS.md`, `.env.example`.
*Acceptance:* DECISIONS.md is ≤ 1 page and covers all six required points; the README's three commands work verbatim; `git log -p | grep -i key` is empty.
*Verification:* execute the README on a freshly dropped database without improvising.

---

---

[← Detailed Step-by-Step Implementation Plan](./06-implementation-steps.md) · [Index](./README.md) · [Testing Plan →](./08-testing-plan.md)
