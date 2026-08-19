# 6. Implementation Plan

> Part 6 of the [Mini Billing Ledger analysis](./README.md).

## Step 1 — Scaffold (~30m)

- **Do:** `nest new`, strict `tsconfig`, `.env`/`.env.example`, `data-source.ts`, npm scripts (`db:up`, `migration:run`, `migration:generate`, `test:e2e`), `.gitignore`, `git init`.
- **Why:** migrations and test DB config gate everything downstream.
- **Result:** `npm run start:dev` boots, connects to PG.
- **Commit:** `chore: scaffold nest project with typeorm and postgres config`

## Step 2 — Entities + migration (~45m)

- **Do:** 4 entities with explicit column names/types; one initial migration; partial unique indexes and CHECK constraints as raw SQL; seed migration for two test orgs.
- **Why:** constraints are half the correctness proof. Get them in the schema before service logic, so the logic can lean on them.
- **Files:** `*/**.entity.ts`, `database/migrations/1_init.ts`, `2_seed_orgs.ts`
- **Prereq:** Step 1.
- **Result:** `migration:run` creates tables; `psql` shows `numeric(12,2)`.
- **Commit:** `feat: add organization, bill, payment and ledger entities with migrations`

## Step 3 — Money helper + validators (~20m)

- **Do:** `Money` (bigint minor units), `@IsMoneyString()` validator rejecting JSON numbers.
- **Why:** locks the string contract at the boundary before controllers exist.
- **Result:** unit tests pass on parse/format/compare; `"0.1"` → `"0.10"`; `100` rejected.
- **Commit:** `feat: add exact money string handling with minor-unit helper`

## Step 4 — Tenant context + scope (~30m)

- **Do:** middleware, `@OrgId()`, `TenantScope` with `*OrThrow` methods, global exception filter.
- **Why:** every service written after this inherits isolation by construction.
- **Prereq:** Step 2.
- **Result:** unknown/other-org id yields 404 from a probe endpoint.
- **Commit:** `feat: enforce tenant scoping from X-Org-Id header with 404 on cross-org access`

## Step 5 — Bills: create / post / void / get (~45m)

- **Do:** `BillsService` with transactional `post()` (lock → status check → ledger append), `LedgerService.append()` + `.balanceFor()`, response mappers.
- **Why:** establishes the transaction + ledger pattern payments will copy.
- **Prereq:** Steps 2–4.
- **Result:** manual curl: create → post → get shows `balance` = `amountDue`.
- **Commit:** `feat: add bill creation, posting with ledger debit, and balance read`

## Step 6 — Payments: idempotent ingest (~50m)

- **Do:** transaction per §4.3, `23505` catch → fresh re-read (`withDeleted`) → 200, status recompute.
- **Why:** the centerpiece.
- **Prereq:** Step 5.
- **Result:** same `externalRef` twice → one payment, one entry, 201 then 200.
- **Commit:** `feat: add idempotent payment ingestion keyed on external ref`

## Step 7 — Reversal (~30m)

- **Do:** transaction per §4.4, soft-delete, reopen.
- **Why:** closes the lifecycle; makes reconciliation testable end to end.
- **Prereq:** Step 6.
- **Result:** post→pay→reverse restores full balance and POSTED.
- **Commit:** `feat: reverse payments with compensating ledger entry and bill reopen`

## Step 8 — Test suite (~1.5h)

- **Do:** `globalSetup` runs migrations on `billing_test`; truncate-between-tests helper; the four required specs.
- **Why:** this is the comparison artifact.
- **Prereq:** Step 7.
- **Result:** `npm run test:e2e` green, concurrency spec included.
- **Commit:** `test: add tenant isolation, idempotency, lifecycle and concurrency e2e tests`

## Step 9 — LLM slice (~45m)

- **Do:** `LlmClient` interface, `StubLlmClient`, `AnthropicLlmClient`, deterministic parse + shortlist, timeout/fallback, validation that suggested `billId` ∈ shortlist, read-only test.
- **Why:** product-judgment score; must not touch money code.
- **Prereq:** Step 5 (needs bills+balance reads only).
- **Result:** `POST /reconciliation/suggest` returns candidates + suggestion; with stub forced to throw, still 200 with `llmAvailable:false`.
- **Commit:** `feat: add LLM-backed bank line match suggestion behind provider interface`

## Step 10 — Docs + polish (~30m)

- **Do:** README (3 commands), DECISIONS.md (≤1 page, all six required points), lint/typecheck clean, `.env.example`, optional Swagger.
- **Prereq:** all.
- **Commits:** `docs: add readme and decisions`, `chore: lint and type-check clean`
