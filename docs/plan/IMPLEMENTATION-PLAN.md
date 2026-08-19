# Mini Billing Ledger — Technical Implementation Plan

**Audience:** implementing developer (sections 3, 6–15, 20, 21) and Project Owner / reviewer (sections 1, 2, 4, 17, 19).
**Source:** `analysis/01..10` (Assignment Analysis).
**Status of codebase:** greenfield. `/mnt/e/projects/personal/algoritmo-exam` contains only `analysis/`. Every path in this document is a path *to be created* unless marked otherwise.
**Time budget:** 4–6 hours (take-home constraint). Every decision below is sized to that budget.

---

## 0. Critical Review of the Prior Analysis

The analysis is strong and mostly correct. It is **not** copied wholesale. The following items are corrected, tightened, or explicitly rejected. Where I disagree, the corrected instruction in this document wins.

### 0.1 Corrections — defects in the prior analysis

| # | Prior analysis says | Problem | Corrected instruction |
|---|---|---|---|
| C1 | §4.4 reversal script: read payment (unlocked) → lock bill → insert reversal | Lock order is inverted relative to the intent, and the payment's `deleted_at` is read **before** any lock is held. Two concurrent `DELETE /payments/:id` on the same payment both pass the `deleted_at IS NULL` check, both proceed, and only the `(payment_id, type)` partial unique index stops the double reversal — as a `23505` surfacing as a 500. | **Lock the bill first, then re-select the payment `FOR UPDATE` and re-check `deleted_at IS NULL` inside the lock.** Only then append the reversal. Losing racer gets a clean 404. See §8.5. |
| C2 | A1: "`deletedAt` column on all entities", including `ledger_entries` | The analysis itself flags the footgun in §8 (`@DeleteDateColumn` silently filters balance reads). Keeping a column that must never be used is an invitation to a wrong balance. | **`ledger_entries` has no `deleted_at` column and no `@DeleteDateColumn`.** Append-only is satisfied by never deleting, not by a soft-delete column nobody may use. Document this in DECISIONS.md as a deliberate reading of "never hard delete". |
| C3 | §5 API table lists `amountPaid` in the `GET /bills/:id` response | Never defined anywhere. Undefined response fields are how contracts drift. | **Define it or drop it.** Defined here as `amountPaid = -1 × SUM(amount) WHERE type IN ('PAYMENT_RECEIVED','PAYMENT_REVERSED')`, i.e. net cash currently applied. DRAFT bill ⇒ `"0.00"`. See §8.6. |
| C4 | §7: replay of the same `externalRef` with a **different amount** → 200 + original payment | Silently ignoring a payload mismatch hides a real upstream bug. But 409 breaks the "idempotent ingestion" requirement. | **Return 200 with the original payment plus `"replayed": true` and a `"warning"` field when the submitted amount differs from the stored one.** No new credit either way. Observable in tests, honest to the caller, still idempotent. |
| C5 | §4.3 / §8: "catch `23505`" | Bare `23505` catching is wrong — the ledger partial unique indexes also raise `23505`. Catching them as "replay" would return 200 for a genuine double-post bug. | **Discriminate on `error.constraint`.** Only `payments_org_external_ref_uq` means replay. Any other `23505` propagates as a 500 (a real invariant breach, and it should be loud). |
| C6 | §4.5 shortlist: "`abs(balance − parsedAmount) < threshold`" | `balance` is not a column. It is a per-bill aggregate over `ledger_entries`. Written naively this is an N+1 or an invalid query. | Shortlist uses **one** query with a `LEFT JOIN LATERAL` (or grouped sub-select) computing balance per candidate bill. Concrete SQL in §8.7. |
| C7 | §4.4: `UPDATE bills SET status = (balance <= 0 ? 'PAID' : 'POSTED')` | Would resurrect a VOID bill to POSTED if a VOID bill ever had ledger rows. Today unreachable (void requires zero payments), but it is a one-token guard. | `UPDATE bills SET status = … WHERE id = $1 AND org_id = $2 AND status IN ('POSTED','PAID')`. Status recompute never touches DRAFT or VOID. |
| C8 | §3 lists `ledger_entries (org_id, bill_id)` composite FK but leaves `payment_id` as a plain FK to `payments(id)` | Asymmetric: a ledger row could reference another tenant's payment. Cheap to close. | Add `UNIQUE (org_id, id)` on `payments` and make it `FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id)`. Same pattern as bills, ~2 extra lines of migration. |

### 0.2 Trims — over-engineering removed

| # | Prior analysis proposes | Verdict |
|---|---|---|
| T1 | `Money` helper with `toMinor`, `fromMinor`, `compare`, `add`, `negate` | **Trim to `normalize`, `negate`, `toMinor`, `isMoneyString`.** All aggregation and all comparison happens in SQL (§0.3 R2), so `add` and `compare` have no caller. Do not write code without a caller in a 5-hour build. |
| T2 | `@nestjs/swagger` "cheap demo win" | **Skip.** It is 20–30 minutes of decorator noise across every DTO, and the README's curl walkthrough serves the same demo purpose. Listed under Future Improvements. |
| T3 | `AnthropicLlmClient` as a real implementation path | **Keep, but strictly timeboxed and untested by CI.** The stub is the default binding and the only client exercised in the suite. The real client exists to prove the interface is real, not to be depended on. If time runs short, ship the interface + stub and say so in DECISIONS.md — that is not a gap, it is the documented design. |
| T4 | Health endpoint (F8) | Keep — 4 lines, and the README references it. |

### 0.3 Reinforcements — decisions I am strengthening

| # | Reinforcement |
|---|---|
| R1 | **`FOR UPDATE` on the bill is the first statement of every money-mutating transaction, without exception** (post, pay, reverse, void). Uniform lock order = no deadlock, and it is one sentence to defend in the interview. |
| R2 | **Status recompute is a single SQL `UPDATE … CASE WHEN (SELECT SUM …) <= 0`.** No balance value ever crosses into TypeScript for a comparison. This removes an entire class of money-in-JS bugs by construction and is strictly simpler than reading the balance out and branching in TS. |
| R3 | **`LedgerService` is the only module allowed to `INSERT` into `ledger_entries` or to compute a balance.** Enforced by convention plus a grep-able test. Single audit point. |

### 0.4 Gaps in the analysis that this plan closes

- **The original assignment brief is not in the repository.** Requirements traceability in §5 is therefore built from `analysis/02-requirements.md`, which is a second-hand source. `TO VERIFY:` before submitting, re-read the original brief and diff it against the §5 table.
- Node.js version, package manager (npm vs pnpm), and the exact Postgres image tag are unstated. `TO VERIFY` — see §16.
- No decision on response shape for `POST /bills/:id/post`: §5 of the analysis says "bill+balance". Fixed here: **all bill-returning endpoints use one shared `BillResponseDto`**, so post/void/get are byte-identical in shape. Removes a whole category of test surprise.

---

## 1. Implementation Overview

**What is being built.** A small multi-tenant billing REST API: organizations own bills, bills accrue payments, and every money movement is written to an append-only ledger. Six endpoints plus a health check and one read-only AI-assisted reconciliation endpoint.

**Why.** This is a take-home assessment. The deliverable is not endpoint breadth — it is a demonstration that five invariants hold under adversarial conditions:

1. One tenant can never see or touch another tenant's data (and gets 404, not 403, so existence does not leak).
2. Money is exact — `numeric(12,2)` in the database, strings end to end, never a JavaScript `number`.
3. A payment processor retrying the same webhook cannot double-credit an account.
4. The ledger is self-reconciling: balance is derived, never stored, and a reversal nets out arithmetically.
5. Nothing is hard-deleted.

**Expected outcome.** `docker run` a Postgres, run migrations, run `npm run test:e2e`, and a suite covering tenant isolation, idempotency, the full lifecycle, and true concurrency goes green — on a database created from migrations alone.

**High-level approach.**

- **Push correctness into Postgres.** Composite tenant foreign keys, sign CHECK constraints, and partial unique indexes make the illegal states physically unrepresentable. The service layer then stays short enough to walk through out loud in 30 minutes.
- **Signed ledger.** `BILL_POSTED = +amountDue`, `PAYMENT_RECEIVED = −amount`, `PAYMENT_REVERSED = +amount`. Therefore `balance = SUM(amount)` — one query, no special-case reversal math.
- **Idempotency from the database, not from application logic.** `UNIQUE (org_id, external_ref)`, insert first, catch the specific constraint violation, re-read in a fresh transaction, return 200.
- **Row-lock the bill first in every money transaction.** The unique index handles duplicate references; the lock handles two *different* payments racing on one bill. Both are needed; they fail for different reasons.
- **The AI slice suggests, never writes.** A deterministic SQL shortlist plus a model that ranks and explains, behind an interface, with a stub as the default binding and a test proving zero writes.

**Areas of the system that change.** All of it — greenfield. The build order is: scaffold → schema → money primitives → tenant scope → bills → payments → reversal → tests → AI slice → docs.

---

## 2. Business Context

**The problem.** A utility billing platform serves many organizations from one shared database. Two failure modes destroy trust in a system like this, and both are invisible until they have already happened:

- **Cross-tenant leakage.** Organization B sees, or worse modifies, Organization A's bills. This is a data-breach-class incident, not a bug report.
- **Double-credited payments.** Payment processors retry webhooks; that is normal and correct behaviour on their side. If the billing system treats each retry as a new payment, customers are credited money they never paid, and the discrepancy surfaces weeks later during reconciliation.

A third, quieter problem: **a cashier who reverses a mistaken payment must leave the books explainable.** Overwriting or deleting the original record makes the correction unauditable.

**Business value.**

- Balances are always provably correct, because they are recalculated from the ledger rather than trusted from a stored field. Nobody has to ask "is the balance column stale?"
- Processor retries and network hiccups are absorbed silently instead of becoming customer complaints.
- Every correction leaves a trail: the original entry stays, a compensating entry is added, and the two net out. That is how accounting works, and it is what an auditor expects.

**Who is affected.**

| Party | Impact |
|---|---|
| Cashier / billing admin | Records payments and reverses mistakes with confidence that the balance stays right. Gets AI-assisted help matching bank lines to bills. |
| Payer | Never double-charged or wrongly credited; the balance they see is the balance that is owed. |
| Payment processor | Can retry freely — the safe default for at-least-once delivery. |
| Each tenant organization | Data is invisible to every other tenant, guaranteed at the database level, not by careful coding. |
| Reviewing engineer | Reads DECISIONS.md and extends the code live. The code has to be defensible out loud. |

**Expected behaviour, in plain language.** A bill is created as a draft. Posting it makes it real and records what is owed. Payments reduce the balance; when the balance reaches zero (or goes below, if someone overpays), the bill is marked paid. Reversing a payment adds a correcting entry, hides the payment from normal views without erasing it, and reopens the bill. Submitting the same processor reference twice is not an error — the second submission returns the payment that already exists, unchanged.

**Why this change is necessary.** It is the assessment. Beyond that, the invariants above are the minimum bar for any system that moves money on behalf of multiple customers.

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

**Reason.** Check-then-insert has a window between the check and the insert, and that window is *exactly* what two simultaneous webhook deliveries occupy. The unique index is the only true serialization point available. On violation (discriminated by constraint name — see C5), the transaction rolls back and a **fresh** transaction re-reads the payment by `(org_id, external_ref)` with `withDeleted: true`, returning 200. The re-read is guaranteed to find the row: our `INSERT` blocks on the index until the competing transaction resolves, so a `23505` means that transaction committed.

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

A global exception filter emits `{ statusCode, code, message }` for everything. It must never echo raw database errors to a client. Business failures map to stable machine-readable codes (§13). Cross-tenant access and missing resources produce **byte-identical** responses — that is the anti-enumeration property, and it is worth an explicit assertion in the isolation spec.

### 3.6 Authentication / authorisation

None, by assignment. `X-Org-Id` is trusted as though set by an upstream authenticated gateway. This assumption is stated in the README, in DECISIONS.md, and as a comment in `tenant.middleware.ts` — an untrusted tenant header in real code is a critical vulnerability, and the reviewer needs to see that the candidate knows the difference between "not required here" and "not needed".

### 3.7 External integrations

Anthropic API, optional, behind `LlmClient`, activated only by `LLM_PROVIDER=anthropic`. Default binding is `StubLlmClient`. No key in the repository; `.env.example` only.

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

> `TO VERIFY:` this table is derived from `analysis/02-requirements.md`. The original assignment brief is not in the repository. Diff this table against the brief before submitting.

### Functional

| ID | Requirement | Priority | Implementation Area | Approach | Verification |
|---|---|---|---|---|---|
| F1 | `POST /bills` creates a DRAFT bill scoped to the header org | Must | `bills.controller.ts`, `bills.service.ts` | Insert with `status='DRAFT'`, `orgId` from `@OrgId()`. No ledger rows. | `ledger-lifecycle.e2e-spec` step 1 |
| F2 | `POST /bills/:id/post` transitions DRAFT→POSTED and writes one `BILL_POSTED` entry, atomically | Must | `bills.service.post()` | One transaction: lock bill → assert DRAFT → `LedgerService.append(+amountDue)` → update status + `posted_at` | Lifecycle spec; "post twice → 409, one entry" |
| F3 | `POST /payments` is idempotent on `externalRef`; writes payment + `PAYMENT_RECEIVED` + recomputes status, atomically | Must | `payments.service.create()` | Lock bill → assert POSTED → insert payment (may raise `23505`) → append `−amount` → SQL status recompute. On `payments_org_external_ref_uq`: rollback, fresh-tx re-read `withDeleted`, 200 | `idempotency.e2e-spec`, `concurrency.e2e-spec` |
| F4 | `DELETE /payments/:id` soft-deletes the payment, appends `PAYMENT_REVERSED`, reopens the bill, atomically | Must | `payments.service.reverse()` | Lock bill → re-select payment `FOR UPDATE`, assert `deleted_at IS NULL` → append `+amount` → set `deleted_at` → SQL status recompute (see C1) | Lifecycle spec; double-reverse → 404 |
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
| B5 | PAID iff balance ≤ 0 and status was POSTED/PAID | Single SQL `UPDATE … CASE WHEN` (C7) | Lifecycle + overpay specs |
| B6 | One `externalRef` per org ⇒ at most one payment and one credit entry, forever | `UNIQUE (org_id, external_ref)` + partial `UNIQUE (payment_id, type)` | Idempotency + concurrency specs |
| B7 | Reversal never mutates the original credit entry | No `UPDATE` path exists on `ledger_entries` | Lifecycle spec compares the row before/after |
| B8 | Payments accepted only on POSTED bills | Service, inside the lock | Payment-on-DRAFT/VOID → 409 |
| B9 | Payment and bill share `org_id` | Composite FK | Schema; isolation spec |
| B10 | Ledger is append-only | `LedgerService` exposes `append` and `balanceFor` only; no `deleted_at` column (C2) | Code review + grep |
| B11 | Cross-org access is 404, never 403, never 200 | `TenantScope` throws `NotFoundException` exclusively | `no-forbidden.e2e-spec` |
| B12 | The AI path never inserts a payment or ledger entry | Module boundary | `reconciliation.e2e-spec` count assertion |

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
| `src/common/money/money.ts` | `normalize`, `negate`, `toMinor` | Trimmed per T1. No `add`, no `compare` — SQL does both |
| `src/common/money/is-money-string.validator.ts` | `@IsMoneyString()` | Rejects non-string input outright; this is the float firewall |
| `src/common/filters/all-exceptions.filter.ts` | Uniform `{ statusCode, code, message }` | Never leaks a driver error message to the client |
| `src/common/health/health.controller.ts` | `GET /health` | Exempt from tenant middleware |
| `src/organizations/organization.entity.ts` | `organizations` table | No controller, no service — seeded only |
| `src/bills/bill.entity.ts` | `bills` table | Includes `UNIQUE (org_id, id)`, the composite-FK target |
| `src/bills/bills.service.ts` | `create`, `post`, `void`, `findOne` | Owns two transactions (`post`, `void`) |
| `src/bills/bills.controller.ts` | Four routes | Thin |
| `src/bills/dto/` | `create-bill.dto.ts`, `bill-response.dto.ts` | One shared response DTO for **all** bill-returning endpoints (see §0.4) |
| `src/payments/payment.entity.ts` | `payments` table | `UNIQUE (org_id, external_ref)`, `UNIQUE (org_id, id)` (C8), composite FK to bills |
| `src/payments/payments.service.ts` | `create` (idempotent), `reverse` | The centrepiece of the assessment |
| `src/payments/payments.controller.ts` | Two routes | `create` must be able to return **either** 201 or 200 — use `@Res({ passthrough: true })` or a custom interceptor, not a fixed `@HttpCode` |
| `src/payments/dto/` | `create-payment.dto.ts`, `payment-response.dto.ts` | Response carries `replayed: boolean` and optional `warning` (C4) |
| `src/ledger/ledger-entry.entity.ts` | `ledger_entries` table | **No `deleted_at`, no `@DeleteDateColumn`** (C2) |
| `src/ledger/ledger.service.ts` | `append(manager, …)`, `balanceFor(manager, …)`, `recomputeBillStatus(manager, …)` | The only writer of ledger rows and the only source of a balance |
| `src/llm/llm-client.interface.ts` | `LlmClient { complete(prompt, opts): Promise<string> }` | Injection token `LLM_CLIENT` |
| `src/llm/stub-llm.client.ts` | Deterministic canned-but-realistic JSON | Default binding; the only client the suite exercises |
| `src/llm/anthropic-llm.client.ts` | Real provider behind `LLM_PROVIDER=anthropic` | Timeboxed; never on the test path |
| `src/reconciliation/reconciliation.service.ts` | Parse → shortlist → rank → validate | Zero write access by construction |
| `src/reconciliation/reconciliation.controller.ts` | `POST /reconciliation/suggest` | Never returns 5xx due to a provider failure |
| `test/helpers/{app,db,fixtures}.ts` | Shared harness | One Nest app per spec file; truncate + reseed in `beforeEach` |
| `test/*.e2e-spec.ts` | Six specs | See §12 |
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
- `UNIQUE (org_id, external_ref)` named **`payments_org_external_ref_uq`** — the idempotency primitive. **Unconditional**, deliberately *not* partial on `deleted_at IS NULL`: a processor reference identifies one real-world event exactly once, forever. Re-crediting on replay-after-refund is precisely the bug idempotency exists to prevent. The constraint name is load-bearing — the service discriminates on it (C5).
- `UNIQUE (org_id, id)` (C8) — target for the ledger's composite payment FK.
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

**No `updated_at`. No `deleted_at`.** (C2) The table is append-only; a soft-delete column that must never be used is a trap, and `@DeleteDateColumn` would silently filter balance queries.

Constraints:

- `FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id)`
- `FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id)` (C8)
- `CHECK ((type = 'BILL_POSTED' AND amount > 0 AND payment_id IS NULL) OR (type = 'PAYMENT_RECEIVED' AND amount < 0 AND payment_id IS NOT NULL) OR (type = 'PAYMENT_REVERSED' AND amount > 0 AND payment_id IS NOT NULL))` — ties sign **and** `payment_id` presence to the type. A wrong-signed or orphaned entry is unrepresentable.
- `CREATE UNIQUE INDEX ledger_one_posting_per_bill ON ledger_entries (bill_id) WHERE type = 'BILL_POSTED'` — double-posting a bill is unrepresentable even if the service regresses.
- `CREATE UNIQUE INDEX ledger_one_entry_per_payment_type ON ledger_entries (payment_id, type) WHERE payment_id IS NOT NULL` — at most one credit and one reversal per payment. Double-credit is unrepresentable.
- `INDEX (org_id, bill_id, created_at)` — the balance query's access path.

### Migration requirements

- Written **by hand**, not via `migration:generate`. The generator cannot express partial unique indexes or multi-clause `CHECK` constraints, and a generated migration that silently diverges from the intended schema is a common submission failure.
- `gen_random_uuid()` is built in on Postgres 13+. `TO VERIFY:` if the image tag turns out to be older, add `CREATE EXTENSION IF NOT EXISTS pgcrypto;` as the migration's first statement.
- Seed migration inserts two organizations with **fixed** UUIDs so tests and README examples can reference them literally.
- **Final verification, not optional:** drop the database entirely, run the full migration chain, run the full suite. A migration that only works against an incrementally-built local database is worthless to a reviewer.

**Backward compatibility:** not applicable. Greenfield, no existing data.

---

## 8. API / Backend Changes

All requests require `X-Org-Id`. All money fields are strings with exactly two decimals, in both directions. Error body is always `{ statusCode, code, message }`.

> Every contract below is **proposed** — it is derived from the analysis, not from an existing implementation.

### 8.1 `POST /bills`

**Purpose.** Create a DRAFT bill.

```jsonc
// request
{ "amountDue": "100.00" }

// 201
{ "id": "…", "amountDue": "100.00", "status": "DRAFT",
  "balance": "0.00", "amountPaid": "0.00", "postedAt": null,
  "createdAt": "…" }
```

**Validation.** `amountDue` via `@IsMoneyString()` — string, `> 0`, ≤ `9999999999.99`, at most 2 decimals. `forbidNonWhitelisted` rejects unknown fields with a 400.

**Errors.** 400 `VALIDATION_FAILED`, 400 `MISSING_ORG_CONTEXT` / `INVALID_ORG_CONTEXT`.

**Behaviour.** Single insert, `status='DRAFT'`, `orgId` from the header. **No ledger entry** — a draft is not yet a receivable (B4). No transaction needed; it is one statement.

### 8.2 `POST /bills/:id/post`

**Purpose.** Make the bill real and record the receivable.

```jsonc
// 200 — same shape as every other bill response
{ "id": "…", "amountDue": "100.00", "status": "POSTED",
  "balance": "100.00", "amountPaid": "0.00", "postedAt": "…" }
```

**Behaviour, in one transaction:**

1. `TenantScope.findBillForUpdateOrThrow(manager, orgId, id)` — `SELECT … WHERE id = $1 AND org_id = $2 FOR UPDATE`. Miss ⇒ 404.
2. Assert `status === 'DRAFT'`, inside the lock. Otherwise 409 `INVALID_BILL_STATE`.
3. `LedgerService.append(manager, { orgId, billId, type: 'BILL_POSTED', amount: bill.amountDue })` — positive.
4. `UPDATE bills SET status = 'POSTED', posted_at = now(), updated_at = now()`.
5. Read the balance and map the response.

**Why the lock plus the re-check plus the partial unique index.** Three layers for the same race, and that is intentional: the lock serializes, the in-lock re-check produces a clean 409 for the loser, and the index guarantees the invariant even if someone later refactors the check away. Only the index survives a code regression.

**Errors.** 404 (missing / other tenant), 409 `INVALID_BILL_STATE`, 400 `VALIDATION_FAILED` (malformed UUID).

### 8.3 `POST /bills/:id/void`

**Purpose.** Complete the state machine — `VOID` exists as a status with no other route to reach it.

**Behaviour, in one transaction:** lock the bill → `DRAFT → VOID` always allowed; `POSTED → VOID` allowed **only** when the bill has zero non-deleted payments; `PAID` or `VOID` ⇒ 409. Voiding a POSTED bill does **not** write a reversing ledger entry — the bill retains its `BILL_POSTED` row and its balance. `TO VERIFY:` this is a judgment call, worth one line in DECISIONS.md; the alternative (a `BILL_VOIDED` negative entry) would need a fourth entry type and is out of scope.

**Errors.** 404, 409 `INVALID_BILL_STATE`, 409 `BILL_HAS_PAYMENTS`.

### 8.4 `POST /payments` — the centrepiece

**Purpose.** Idempotently record a payment against a posted bill.

```jsonc
// request
{ "billId": "…", "amount": "40.00", "externalRef": "REF-1" }

// 201 (new) / 200 (replay) — identical shape
{ "payment": { "id": "…", "billId": "…", "amount": "40.00",
               "externalRef": "REF-1", "createdAt": "…", "reversedAt": null },
  "bill": { "id": "…", "amountDue": "100.00", "status": "POSTED",
            "balance": "60.00", "amountPaid": "40.00", "postedAt": "…" },
  "replayed": false,
  "warning": null }
```

**Validation.** `billId` UUID; `amount` `@IsMoneyString()`; `externalRef` non-empty trimmed string ≤ 128 chars. A JSON *number* in `amount` is a 400 — assert this explicitly in a test, it is the float firewall.

**Behaviour — transaction 1:**

1. Lock the bill: `SELECT … WHERE id = :billId AND org_id = :orgId FOR UPDATE`. Miss ⇒ 404.
2. Assert `status === 'POSTED'`. Otherwise 409 `INVALID_BILL_STATE` (covers DRAFT, PAID, VOID — B8).
3. `INSERT INTO payments (…)`. **May raise `23505`.**
4. `LedgerService.append(… 'PAYMENT_RECEIVED', Money.negate(amount))` — negative.
5. `LedgerService.recomputeBillStatus(manager, orgId, billId)` — one statement:
   ```sql
   UPDATE bills SET status = CASE
       WHEN (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
             WHERE bill_id = $1 AND org_id = $2) <= 0 THEN 'PAID'
       ELSE 'POSTED' END,
     updated_at = now()
   WHERE id = $1 AND org_id = $2 AND status IN ('POSTED','PAID')
   ```
   No balance value crosses into TypeScript (R2). The `status IN` guard is C7.
6. Commit ⇒ **201**.

**Behaviour on `23505`:**

- If `error.constraint !== 'payments_org_external_ref_uq'`, **rethrow.** Any other unique violation is a genuine invariant breach and must surface as a 500 (C5).
- Otherwise: the transaction is already aborted — Postgres refuses every subsequent statement in it, which is the most common way this pattern is implemented incorrectly. Let it roll back, then in a **brand-new transaction** re-read `payments` by `(org_id, external_ref)` with **`withDeleted: true`**, so a replay after a reversal resolves to the reversed payment instead of 404-ing.
- Compare the submitted `amount` with the stored one. If they differ, set `warning: 'AMOUNT_MISMATCH_ON_REPLAY'` (C4). Either way, **no new credit.**
- Respond **200** with `replayed: true`.

**Why the re-read always succeeds.** The `INSERT` blocks on the unique index until the competing transaction resolves. A `23505` therefore means that transaction committed, so the row is visible to a transaction started afterwards under READ COMMITTED.

**Errors.** 400, 404 (bill missing or another tenant's), 409 `INVALID_BILL_STATE`, 503 on database unavailability with no partial write.

### 8.5 `DELETE /payments/:id` — reversal (revised, C1)

**Purpose.** Reverse a payment without destroying its record.

```jsonc
// 200
{ "payment": { "id": "…", "amount": "60.00", "reversedAt": "…" },
  "bill": { "id": "…", "status": "POSTED", "balance": "60.00",
            "amountPaid": "40.00", "amountDue": "100.00" } }
```

**Behaviour, in one transaction — note the corrected ordering:**

1. Resolve the payment's `bill_id` with an unlocked read scoped to `(id, org_id)`. Miss ⇒ 404.
2. **Lock the bill** `FOR UPDATE`. Always first among locks (R1).
3. **Re-select the payment `FOR UPDATE`** and re-check `deleted_at IS NULL` **inside** the bill lock. If it is already reversed ⇒ 404 (consistent with soft-deleted rows being invisible to the tenant, A4). *This step is the correction: without it, two concurrent reversals both pass the check and collide on the partial unique index as a 500 instead of a clean 404.*
4. `LedgerService.append(… 'PAYMENT_REVERSED', +payment.amount, payment_id)` — positive.
5. `UPDATE payments SET deleted_at = now() WHERE id = $1`.
6. `recomputeBillStatus(...)` — the same single statement as §8.4.
7. Commit ⇒ 200.

**The original `PAYMENT_RECEIVED` row is never read, updated, or deleted** (B7).

**Critical implementation note, worth a code comment:** the balance query must **not** join to `payments` or filter on `payments.deleted_at`. Ledger entries are the truth; payments are merely their origin. Filtering the balance by payment soft-delete would double-count the reversal and silently break reconciliation. This is the single most likely live-interview question in the build.

**Errors.** 400 (malformed UUID), 404 (missing, another tenant's, or already reversed).

### 8.6 `GET /bills/:id`

```jsonc
// 200
{ "id": "…", "amountDue": "100.00", "status": "POSTED",
  "balance": "60.00", "amountPaid": "40.00", "postedAt": "…" }
```

- `balance` = `SELECT COALESCE(SUM(amount), 0)::numeric(12,2)::text FROM ledger_entries WHERE bill_id = $1 AND org_id = $2`. The `::text` cast guarantees a two-decimal string from the driver and removes any doubt about client-side formatting.
- `amountPaid` (C3 — previously undefined) = `-1 × SUM(amount) WHERE type IN ('PAYMENT_RECEIVED','PAYMENT_REVERSED')`, i.e. net cash currently applied. DRAFT ⇒ `"0.00"`. Computed in the **same** query as `balance` via `FILTER (WHERE …)`; do not issue a second round trip.
- A DRAFT bill returns `"0.00"` — never `null`, never `"0"` (edge case 15).

**Errors.** 400 (malformed UUID), 404 (missing or another tenant's — byte-identical responses).

### 8.7 `POST /reconciliation/suggest` — read-only AI slice

```jsonc
// request
{ "rawLine": "GCASH TRANSFER PHP 1,250.00 REF 8891 2026-08-14" }

// 200
{ "parsed": { "amount": "1250.00", "reference": "8891", "date": "2026-08-14" },
  "candidates": [ { "billId": "…", "amountDue": "1250.00", "balance": "1250.00", "score": 0.98 } ],
  "suggestion": { "billId": "…", "confidence": 0.91,
                  "reasoning": "Exact balance match and reference 8891 appears in the line." },
  "llmAvailable": true,
  "warning": null }
```

**Behaviour:**

1. **Deterministic parse in code** (regex): amount, reference token, date. The model is never trusted with the amount — that is the whole guardrail.
2. **Deterministic shortlist in SQL**, one query, no N+1 (C6):
   ```sql
   SELECT b.id, b.amount_due::text,
          COALESCE(l.balance, 0)::numeric(12,2)::text AS balance
   FROM bills b
   LEFT JOIN LATERAL (
     SELECT SUM(amount) AS balance FROM ledger_entries le
     WHERE le.bill_id = b.id AND le.org_id = b.org_id
   ) l ON TRUE
   WHERE b.org_id = $1 AND b.status = 'POSTED' AND b.deleted_at IS NULL
     AND ABS(COALESCE(l.balance, 0) - $2::numeric) < $3::numeric
   ORDER BY ABS(COALESCE(l.balance, 0) - $2::numeric) ASC
   LIMIT 5
   ```
   `TO VERIFY:` the threshold (suggest `100.00`) and whether reference-substring matching is worth adding as an `OR` branch. Start with the amount-proximity match only; add the reference branch if the stub demo looks thin.
3. The model receives the already-parsed amount and the shortlist, and returns JSON only. It ranks and writes the explanation. It does not compute money.
4. **Validate the response**: parseable JSON, and `billId` **must** be a member of the shortlist. Otherwise drop the suggestion and return the candidates with a warning. A hallucinated bill id shown to a cashier is the exact harm to prevent.
5. **Failure handling**: `AbortController` with a 3-second timeout, and a catch-all. Any provider error, timeout, or malformed output ⇒ **200** with the deterministic candidates and `llmAvailable: false`. This endpoint never returns 5xx because of the provider (N7).
6. **Zero writes.** No injected repository or manager on any write path. Asserted by a test that snapshots `payments` and `ledger_entries` counts across a suggest call.

**Errors.** 400 on a missing or empty `rawLine`; 400 when nothing parseable is found. Never 5xx from the provider.

### 8.8 `GET /health`

`{ "status": "ok" }`. Exempt from tenant middleware. Referenced in the README as the first verification step.

---

## 9. Frontend / UI Changes

**None. This is a backend-only API assignment.** No pages, components, or client state.

The two client-facing surfaces that still need deliberate design:

**1. The HTTP contract as the interface.** Response shapes are stable and shared: one `BillResponseDto` for every bill-returning endpoint, one `PaymentResponseDto` for both payment endpoints. Money is always a string with exactly two decimals. Error bodies are always `{ statusCode, code, message }` with a machine-readable `code` a client can branch on.

**2. The intended human workflow for the AI slice.** The design point is that the human stays in control:

```text
Cashier pastes an unmatched bank line
    ↓
POST /reconciliation/suggest        (read-only — nothing is written)
    ↓
API parses the amount deterministically and shortlists candidate bills in SQL
    ↓
Model ranks the shortlist and explains its pick
    ↓
Cashier reads the suggestion and the candidates
    ↓
Cashier decides — the system does not
    ↓
Cashier calls POST /payments with the externalRef  ← the only step that moves money
```

If the model is unavailable, the cashier still receives the ranked shortlist and continues unblocked. The feature degrades; it does not disappear.

For contrast, the money lifecycle the API exposes:

```text
POST /bills                    → DRAFT,  balance "0.00"
POST /bills/:id/post           → POSTED, balance "100.00", 1 ledger entry
POST /payments  "40.00"        → POSTED, balance "60.00",  2 entries
POST /payments  "60.00"        → PAID,   balance "0.00",   3 entries
DELETE /payments/:id (the 60)  → POSTED, balance "60.00",  4 entries — none removed
```

---

## 10. Detailed Step-by-Step Implementation Plan

Steps are in strict dependency order. Commit at every step boundary using conventional commits — the history is a graded deliverable, and ten commits each defensible out loud beats one large drop.

Running budget in brackets. Target total ≈ 5h.

---

### Step 1 — Scaffold and database connectivity `[~30m]`

**Objective.** A booting NestJS application that connects to Postgres and can run migrations, before any domain code exists.

**Changes**

- `nest new` (or a manual minimal scaffold), `git init`.
- `tsconfig.json`: `strict: true`, `strictNullChecks`, `noImplicitAny`.
- `.env`, `.env.example`, `.gitignore` (`.env` **must** be listed before the first commit).
- `src/database/data-source.ts` — one exported `DataSource` shared by the app and the TypeORM CLI.
- npm scripts.

**Implementation**

1. Scaffold and initialise git. Add `.gitignore` with `node_modules`, `dist`, `.env`, `coverage`.
2. Write `.env.example`:
   ```bash
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/billing
   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/billing_test
   PORT=3000
   LLM_PROVIDER=stub          # stub | anthropic
   ANTHROPIC_API_KEY=         # leave empty; never commit a real key
   LLM_TIMEOUT_MS=3000
   ```
   Copy it to `.env` with local values.
3. Write `src/database/data-source.ts`:
   - `type: 'postgres'`, `url` from env.
   - **`synchronize: false`** — required, and the single most important line in the file.
   - `entities: [__dirname + '/../**/*.entity{.ts,.js}']`, `migrations: [__dirname + '/migrations/*{.ts,.js}']`.
   - Pool `max: 10` — the concurrency spec is meaningless against a size-1 pool.
   - **Add a comment stating that no `pg` numeric type parser is registered, and why.** This is the exact trap the assignment is testing; make it visible.
4. Add scripts to `package.json`:
   ```json
   "db:up": "docker run --name billing-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:15",
   "db:create-test": "TO VERIFY — psql -c 'CREATE DATABASE billing_test'",
   "migration:run": "typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts",
   "migration:revert": "typeorm-ts-node-commonjs migration:revert -d src/database/data-source.ts",
   "test:e2e": "jest --config ./test/jest-e2e.json --runInBand",
   "typecheck": "tsc --noEmit"
   ```
5. Wire `TypeOrmModule.forRoot` in `app.module.ts` from the same `DataSource` options.

**Reason.** Migrations and test-database configuration gate everything downstream. Getting `synchronize: false` and the money-string driver behaviour right *before* any entity exists prevents a whole class of rework.

**Dependencies.** None.

**Expected result.** `npm run start:dev` boots and logs a successful database connection.

**Verification.** Application starts with no error; `docker ps` shows the Postgres container; `psql` connects.

**Commit.** `chore: scaffold nest project with typeorm and postgres config`

---

### Step 2 — Entities and the init migration `[~45m]`

**Objective.** The complete schema, with every constraint from §7, created by a hand-written migration.

**Changes**

- Four entity files.
- `src/database/migrations/<ts>-Init.ts`.
- `src/database/migrations/<ts>-SeedOrgs.ts`.

**Implementation**

1. Write the entities with an explicit `name:` on **every** column (`snake_case` in the database, `camelCase` in TypeScript).
   - Money columns: `@Column({ type: 'numeric', precision: 12, scale: 2, name: 'amount' }) amount!: string;` — note the TypeScript type is `string`.
   - `@DeleteDateColumn({ name: 'deleted_at' })` on `Organization`, `Bill`, `Payment`.
   - **`LedgerEntry` gets neither `deleted_at` nor `updated_at`** (C2).
2. Write `Init` migration `up()` **by hand** as raw SQL. Order: `organizations` → `bills` → `payments` → `ledger_entries`, so foreign keys resolve. Include every `CHECK`, both composite `UNIQUE (org_id, id)` targets, `payments_org_external_ref_uq` **by that exact name**, both partial unique indexes, and the supporting indexes.
3. Write `down()` as the reverse drop order. It will rarely be used, but a migration without a working `down()` is an incomplete migration.
4. Write `SeedOrgs` inserting two organizations with **fixed, literal UUIDs**. Export those UUIDs from a shared test-fixture constant later so nothing is duplicated.
5. Run `npm run migration:run`.

**Reason.** Constraints are half the correctness proof for this assignment. Landing them before the service layer means the service layer can lean on them rather than duplicating them — which is what keeps it short enough to explain.

**Dependencies.** Step 1.

**Expected result.** Four tables exist with all constraints. `\d+ bills` shows `numeric(12,2)`. `\di` lists both partial unique indexes.

**Verification.**
```sql
INSERT INTO ledger_entries (org_id, bill_id, type, amount) VALUES (…, 'BILL_POSTED', -5);  -- must fail on CHECK
-- insert two BILL_POSTED rows for one bill                                                 -- second must fail
-- insert a payment whose org_id does not match its bill's org_id                           -- must fail on composite FK
```
Run all three by hand once. They are the proof that the schema, not the code, is doing the work.

**Commit.** `feat: add organization, bill, payment and ledger entities with migrations`

---

### Step 3 — Money primitives `[~20m]`

**Objective.** Lock the money-as-string contract at the request boundary before any controller exists.

**Changes**

- `src/common/money/money.ts` — `normalize(s): string`, `negate(s): string`, `toMinor(s): bigint`.
- `src/common/money/is-money-string.validator.ts` — `@IsMoneyString()`.
- `src/common/money/money.spec.ts` — unit tests.

**Implementation**

1. `normalize("0.1")` → `"0.10"`; `normalize("100")` → `"100.00"`. Pad and validate; throw on anything unparseable.
2. `negate("40.00")` → `"-40.00"`. String manipulation or `bigint` minor units — never `parseFloat`.
3. `toMinor` exists for unit-testable comparisons only. **No `add`, no `compare`** (T1) — SQL performs both.
4. The validator: reject when `typeof value !== 'string'`, then test `/^\d{1,10}(\.\d{1,2})?$/`, then require `> 0`. Message: `"amount must be a decimal string with up to 2 decimal places, e.g. \"100.00\""`.
5. Unit-test: `"0.1"` → `"0.10"`; the number `100` is rejected; `"40.555"` is rejected; `"0"` and `"-5.00"` are rejected; `"9999999999.99"` is accepted.

**Reason.** This validator is the firewall that keeps floats out of the system. Everything downstream assumes it holds.

**Dependencies.** Step 1.

**Expected result.** `npm test -- money` green.

**Verification.** Unit tests, including explicitly rejecting a JSON number.

**Commit.** `feat: add exact money string handling with minor-unit helper`

---

### Step 4 — Tenant context, scope, and the exception filter `[~30m]`

**Objective.** Every service written after this point inherits tenant isolation by construction.

**Changes**

- `tenant.middleware.ts`, `org-id.decorator.ts`, `tenant-scope.service.ts`, `all-exceptions.filter.ts`, `health.controller.ts`.

**Implementation**

1. Middleware: read `x-org-id`. Missing ⇒ `BadRequestException` with code `MISSING_ORG_CONTEXT`. Not a UUID ⇒ `INVALID_ORG_CONTEXT`. Otherwise attach `req.orgId`. **Do not** verify the organization exists here — a valid-but-unknown UUID must produce 404s from resource lookups, identically to another tenant's resources.
2. Bind the middleware in `app.module.ts` for all routes **except** `GET /health`.
3. `@OrgId()` param decorator returning `req.orgId`. Use it explicitly in every controller signature — the verbosity is the point, since a missing tenant scope becomes visible in a diff.
4. `TenantScope`:
   - `findBillOrThrow(manager, orgId, billId)`
   - `findBillForUpdateOrThrow(manager, orgId, billId)` — appends `FOR UPDATE`
   - `findPaymentOrThrow(manager, orgId, paymentId, opts?: { forUpdate, withDeleted })`
   - **Every miss throws `NotFoundException`. This file must never import `ForbiddenException`** — that is the 404-not-403 invariant, in one grep-able place.
5. Global exception filter mapping to `{ statusCode, code, message }`; unknown errors become a 500 with a generic message and are logged server-side in full. Never echo a driver error.
6. `GET /health`.

**Reason.** A single choke point plus a schema backstop is the whole isolation strategy. Building it before the domain services means no service ever has the opportunity to hand-roll a lookup.

**Dependencies.** Steps 1–2.

**Expected result.** `GET /bills/<any-uuid>` with a valid but unknown org header returns 404 with the standard error body. A missing header returns 400.

**Verification.** curl both cases against a temporary probe route (or wait for Step 5).

**Commit.** `feat: enforce tenant scoping from X-Org-Id header with 404 on cross-org access`

---

### Step 5 — Ledger service and bills `[~45m]`

**Objective.** Establish the transaction-plus-ledger pattern that payments will copy, and get a readable balance.

**Changes**

- `ledger.service.ts` with `append`, `balanceFor`, `recomputeBillStatus`.
- `bills.service.ts` with `create`, `post`, `void`, `findOne`; `bills.controller.ts`; DTOs.

**Implementation**

1. `LedgerService.append(manager, { orgId, billId, paymentId?, type, amount })` — a plain insert. **The only writer of `ledger_entries` in the codebase** (R3). No update or delete method exists; do not add one.
2. `LedgerService.balanceFor(manager, orgId, billId): Promise<string>`:
   ```sql
   SELECT COALESCE(SUM(amount), 0)::numeric(12,2)::text AS balance,
          (-1 * COALESCE(SUM(amount) FILTER (
              WHERE type IN ('PAYMENT_RECEIVED','PAYMENT_REVERSED')), 0))::numeric(12,2)::text
          AS amount_paid
   FROM ledger_entries WHERE bill_id = $1 AND org_id = $2
   ```
   One round trip returns both fields (§8.6, C3). **Add the comment: this query must never join to `payments` or filter on `payments.deleted_at`.**
3. `LedgerService.recomputeBillStatus(manager, orgId, billId)` — the single `UPDATE … CASE WHEN` from §8.4, including the `status IN ('POSTED','PAID')` guard (C7). No balance value enters TypeScript (R2).
4. `BillsService.create` — one insert, no transaction.
5. `BillsService.post` — `dataSource.transaction(...)`: lock → assert DRAFT → append `+amountDue` → update status and `posted_at` → map the response.
6. `BillsService.void` — transaction: lock → allow DRAFT→VOID; POSTED→VOID only when `COUNT(payments WHERE deleted_at IS NULL) = 0`; else 409.
7. `BillsService.findOne` — `TenantScope.findBillOrThrow` + `balanceFor`.
8. One `BillResponseDto` and one mapper used by **all four** bill endpoints (§0.4).
9. Log one line per completed money transaction: `orgId`, bill id, resulting status. **Never amounts** (N11).

**Reason.** `post()` is the smallest complete instance of the pattern — lock, check, append, recompute. Getting it right here means `payments` is a near-mechanical copy.

**Dependencies.** Steps 2–4.

**Expected result.** curl create → post → get yields `balance` equal to `amountDue`, as a two-decimal string.

**Verification.**
```bash
curl -s -XPOST localhost:3000/bills -H 'X-Org-Id: <A>' -H 'content-type: application/json' -d '{"amountDue":"100.00"}'
curl -s -XPOST localhost:3000/bills/<id>/post -H 'X-Org-Id: <A>'
curl -s localhost:3000/bills/<id> -H 'X-Org-Id: <A>'   # balance "100.00"
curl -s localhost:3000/bills/<id> -H 'X-Org-Id: <B>'   # 404
```

**Commit.** `feat: add bill creation, posting with ledger debit, and balance read`

---

### Step 6 — Idempotent payment ingestion `[~50m]`

**Objective.** The centrepiece: the same `externalRef` submitted twice — sequentially or simultaneously — yields exactly one payment and one credit entry.

**Changes**

- `payments.service.create()`, `payments.controller.ts`, DTOs.

**Implementation**

1. Implement transaction 1 exactly as §8.4: lock the bill → assert POSTED → insert the payment → append the negative credit → `recomputeBillStatus`.
2. Wrap the transaction in a `try/catch`. In the catch:
   - Narrow to a driver error with `code === '23505'`.
   - **If `error.constraint !== 'payments_org_external_ref_uq'`, rethrow** (C5).
   - Otherwise call a separate `resolveReplay(orgId, externalRef)` method that opens its **own** transaction (or uses the plain repository) and re-reads with `withDeleted: true`.
3. Compare the submitted amount to the stored amount; on mismatch set `warning: 'AMOUNT_MISMATCH_ON_REPLAY'` (C4). Never create a second credit.
4. Return a discriminated result — e.g. `{ created: boolean, payload }` — and let the controller set the status code:
   ```ts
   @Post()
   async create(@OrgId() orgId: string, @Body() dto: CreatePaymentDto, @Res({ passthrough: true }) res: Response) {
     const r = await this.payments.create(orgId, dto);
     res.status(r.created ? 201 : 200);
     return r.payload;
   }
   ```
   Do **not** put a fixed `@HttpCode` on this route.
5. Add the code comment explaining why the catch cannot continue inside the same transaction: Postgres aborts a transaction on error and rejects every subsequent statement in it. This is the most common way this pattern is implemented wrongly.

**Reason.** The database's unique index is the only real serialization point between two simultaneous webhook deliveries. Application-level check-then-insert has a window, and that window is exactly what is being tested.

**Dependencies.** Step 5.

**Expected result.** Same `externalRef` twice ⇒ 201 then 200, one payment row, one `PAYMENT_RECEIVED` row, balance reduced once.

**Verification.** curl the same body twice; confirm the status codes, then `SELECT count(*) FROM payments WHERE external_ref = 'REF-1'` returns 1.

**Commit.** `feat: add idempotent payment ingestion keyed on external ref`

---

### Step 7 — Reversal `[~30m]`

**Objective.** Reverse a payment without destroying its record, and reopen the bill correctly.

**Changes**

- `payments.service.reverse()`, `DELETE /payments/:id`.

**Implementation**

1. Implement §8.5 with the **corrected ordering** (C1): resolve `bill_id` → lock the bill → **re-select the payment `FOR UPDATE` and re-check `deleted_at IS NULL` inside the lock** → append `+amount` with `payment_id` → set `deleted_at` → `recomputeBillStatus`.
2. Already-reversed ⇒ `NotFoundException` (A4).
3. Never touch the original `PAYMENT_RECEIVED` row (B7).
4. Return both the payment and the refreshed bill.

**Reason.** Reversal is where naive ledgers break, because the temptation is to subtract from a stored balance or to delete the credit. Appending a compensating entry and recomputing keeps reconciliation provable and the audit trail intact.

**Dependencies.** Step 6.

**Expected result.** post → pay in full → reverse restores the full balance and returns the bill to POSTED, with four ledger rows and none removed.

**Verification.**
```sql
SELECT type, amount FROM ledger_entries WHERE bill_id = '…' ORDER BY created_at;
-- BILL_POSTED +100.00 | PAYMENT_RECEIVED -40.00 | PAYMENT_RECEIVED -60.00 | PAYMENT_REVERSED +60.00
SELECT SUM(amount) FROM ledger_entries WHERE bill_id = '…';   -- 60.00
```

**Commit.** `feat: reverse payments with compensating ledger entry and bill reopen`

---

### Step 8 — Test suite `[~1h30m]`

**Objective.** The comparison artifact. This is what the assignment is actually graded on after correctness.

**Changes**

- `test/helpers/{app,db,fixtures}.ts`, `test/jest-e2e.json`, and six spec files.

**Implementation**

1. `jest-e2e.json` with `globalSetup` running migrations against `billing_test`, and `--runInBand` so specs do not fight over the database.
2. `helpers/db.ts`: `TRUNCATE organizations, bills, payments, ledger_entries RESTART IDENTITY CASCADE`, then reseed both organizations. Call in `beforeEach`.
3. `helpers/app.ts`: build one Nest application per spec file; **`await app.listen(0)`** so the concurrency spec issues real parallel HTTP requests rather than in-process calls.
4. `helpers/fixtures.ts`: the seeded organization UUIDs, plus `createPostedBill(orgId, amount)`.
5. Write the specs in the order of §12: isolation → idempotency → lifecycle → concurrency → reconciliation → the no-`ForbiddenException` guard.
6. Assert **exact strings** for every money field: `"100.00"`, never `"100"`, never `100`. Add `expect(typeof body.balance).toBe('string')`.

**Reason.** Every invariant in this build lives in a transaction, a constraint, or a lock. Unit tests with mocked repositories cannot observe any of them. Integration tests against real Postgres are the only level at which the claims are actually proven — which is why unit tests are limited to `Money` and the AI response validator.

**Dependencies.** Step 7.

**Expected result.** `npm run test:e2e` green, including the concurrency spec, repeatably.

**Verification.** Run the suite five times consecutively. Any flake in the concurrency spec is a real finding, not test noise — investigate rather than retry.

**Commit.** `test: add tenant isolation, idempotency, lifecycle and concurrency e2e tests`

---

### Step 9 — AI reconciliation slice `[~45m — hard timebox]`

**Objective.** A useful, read-only suggestion feature that cannot touch money.

**Changes**

- `llm/` (interface, stub, Anthropic client, module), `reconciliation/` (service, controller, DTOs).

**Implementation**

1. `LlmClient` interface: `complete(prompt: string, opts: { signal: AbortSignal }): Promise<string>`. Injection token `LLM_CLIENT`.
2. `StubLlmClient` returns canned-but-realistic JSON, selecting the closest candidate from the prompt. This is the **default binding** and the only client the suite exercises.
3. `AnthropicLlmClient` bound only when `LLM_PROVIDER=anthropic`. Key from env. Timebox strictly; if it threatens the budget, ship the interface plus stub and say so in DECISIONS.md — that is a documented design decision, not a gap.
4. `ReconciliationService`:
   - Regex parse of amount, reference, and date. **Deterministic, in code.**
   - The shortlist query from §8.7 — one query, `LEFT JOIN LATERAL`, limit 5.
   - Build the prompt from the parsed amount and the shortlist; the model ranks only.
   - Validate the response: parseable JSON **and** `billId ∈ shortlist`. Otherwise drop the suggestion and return a warning.
   - `AbortController` with `LLM_TIMEOUT_MS` (default 3000) and a catch-all ⇒ 200 with candidates and `llmAvailable: false`.
   - **Inject nothing that can write.** Read-only queries and `LlmClient`, and nothing else.
5. Spec: valid suggestion → 200; stub throws → 200 with `llmAvailable: false`; stub returns an out-of-shortlist `billId` → suggestion dropped; and after every case, `payments` and `ledger_entries` counts are unchanged.

**Reason.** This scores product judgment. The judgment being demonstrated is that a non-deterministic component belongs beside the money path, never inside it — and that a graceful degradation to a deterministic shortlist is better than a feature that vanishes when a provider is down.

**Dependencies.** Step 5 only — it needs bills and balance reads, nothing from payments. It can be built in parallel with Steps 6–8 if the schedule slips.

**Expected result.** `POST /reconciliation/suggest` returns parsed values, candidates, and a suggestion; forcing the stub to throw still returns 200.

**Verification.** The reconciliation spec, including the zero-writes assertion.

**Commit.** `feat: add LLM-backed bank line match suggestion behind provider interface`

---

### Step 10 — Fresh-database verification, documentation, polish `[~30m]`

**Objective.** Guarantee the submission runs on a reviewer's machine, and make the reasoning legible.

**Changes**

- `README.md`, `DECISIONS.md`, final lint and type-check pass.

**Implementation**

1. **Do this first, before writing any documentation:**
   ```bash
   docker rm -f billing-pg && npm run db:up
   # recreate both databases, then:
   npm run migration:run && npm run test:e2e
   ```
   A migration chain that only works against an incrementally-built local database is a classic submission failure. Catch it here.
2. `README.md`: assumptions (trusted header, seeded organizations, single currency), then exactly three commands to a green suite, then a curl walkthrough of the full lifecycle using the seeded organization UUIDs.
3. `DECISIONS.md`, **one page**, written from the code that exists. Six required points:
   - `numeric(12,2)` + strings, never floats — and the reason the pg parser is left alone.
   - Idempotency: unique index, insert-first, constraint-name discrimination, fresh-transaction re-read, replay-after-reversal semantics (and that this is the one genuinely under-specified point in the brief).
   - Tenant isolation: choke point plus composite foreign keys, and why 404 rather than 403.
   - Reversal: compensating entry, balance recomputed from the ledger, the original row untouched.
   - The AI feature and its guardrails.
   - **One thing I would do differently:** Postgres RLS, plus a denormalized in-transaction `bills.balance` cache — both named as the point where this design stops scaling.
4. `npm run lint`, `npm run typecheck`, and the grep sweep from §21.
5. `git log -p | grep -i -E 'api[_-]?key|secret|sk-ant'` — must be empty.

**Reason.** A submission that does not start on the reviewer's machine loses more than any missing feature. And the reasoning is what is being graded — DECISIONS.md is where it lives.

**Dependencies.** All prior steps.

**Expected result.** A clean clone plus three commands produces a green suite.

**Verification.** Read the README as a stranger and execute the commands verbatim, without improvising.

**Commits.** `docs: add readme and decisions`, `chore: lint and type-check clean`

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
*Objective:* four entities mirroring §7 exactly.
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
*Changes:* §8.5 with the corrected lock ordering; soft-delete; status recompute.
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

## 12. Testing Plan

**Test level, and why.** Integration/e2e against real Postgres is the correct level here, and it is a deliberate decision rather than a shortcut. Every invariant in this build lives in a transaction, a constraint, or a row lock. A unit test with a mocked repository cannot observe a unique index firing, a `FOR UPDATE` serializing two requests, or a `CHECK` rejecting a wrong-signed amount — it can only observe that the code called the mock. Testing at that level would produce a green suite that proves nothing about the graded properties.

Unit tests are therefore limited to the two pieces of pure logic: `Money` and the AI response validator.

**Harness.** Jest + supertest. `globalSetup` runs migrations against `billing_test`. `beforeEach` truncates all four tables and reseeds both organizations. One Nest application per spec file, started with `app.listen(0)` so concurrency tests issue real parallel HTTP requests. Connection pool `max ≥ 5`, otherwise the concurrency spec silently serializes and proves nothing. Jest runs `--runInBand` across files.

### Unit tests

| Target | Cases |
|---|---|
| `Money.normalize` | `"0.1"` → `"0.10"`; `"100"` → `"100.00"`; `"9999999999.99"` accepted |
| `Money.negate` | `"40.00"` → `"-40.00"`; round-trips |
| `@IsMoneyString` | rejects the number `100`; rejects `"40.555"`, `""`, `"abc"`, `"0"`, `"-5.00"`; accepts `"0.01"` |
| AI response validator | rejects non-JSON; rejects a `billId` outside the shortlist; accepts a well-formed response |

### Required scenario 1 — tenant isolation

```text
Seed:  orgA with bill B (POSTED, 100.00) and one payment P; orgB with nothing.
Snapshot counts of payments and ledger_entries.

GET    /bills/B                    as orgB   → 404
POST   /payments {billId: B, …}    as orgB   → 404
DELETE /payments/P                 as orgB   → 404
POST   /bills/B/post               as orgB   → 404
POST   /bills/B/void               as orgB   → 404

Assert: payments count unchanged.
Assert: ledger_entries count unchanged.
Assert: no response body contains B's amountDue or any of orgA's identifiers.
Assert: the 404 body for another tenant's bill is byte-identical to the 404 body for a random UUID.
```

The row counts are the real assertion — a 404 that still wrote a row would pass a naive status-code-only test. The byte-identical assertion is the anti-enumeration property.

### Required scenario 2 — idempotency

```text
Given a POSTED bill of 100.00 in orgA:

POST /payments {externalRef:"REF-1", amount:"40.00"}  → 201, payment P
POST /payments {externalRef:"REF-1", amount:"40.00"}  → 200, body.payment.id === P.id, replayed === true

SELECT count(*) FROM payments       WHERE external_ref='REF-1'      → 1
SELECT count(*) FROM ledger_entries WHERE type='PAYMENT_RECEIVED'   → 1
GET /bills/:id → balance "60.00"      (not "20.00" — the double-credit failure)

Plus: same ref with amount "55.00"  → 200, original 40.00 payment returned,
                                       warning "AMOUNT_MISMATCH_ON_REPLAY", balance still "60.00"
Plus: same ref submitted as orgB     → 201, a separate payment (refs are per-org)
```

### Required scenario 3 — full lifecycle and reconciliation

```text
POST /bills {amountDue:"100.00"}   → DRAFT,  balance "0.00",  0 entries
POST /bills/:id/post               → POSTED, balance "100.00", 1 entry
POST /payments "40.00" (REF-A)     → POSTED, balance "60.00",  2 entries
POST /payments "60.00" (REF-B)     → PAID,   balance "0.00",   3 entries
DELETE /payments/:refB             → POSTED, balance "60.00",  4 entries

Assert: SELECT SUM(amount) FROM ledger_entries WHERE bill_id = :id  →  60.00
Assert: 4 rows, types in order [BILL_POSTED, PAYMENT_RECEIVED, PAYMENT_RECEIVED, PAYMENT_REVERSED]
Assert: the REF-B PAYMENT_RECEIVED row is unchanged (same id, same amount, same created_at)
Assert: the REF-B payment row has deleted_at set — and still exists
Assert: every money field in every response is a string matching /^-?\d+\.\d{2}$/
Assert: amountPaid === "40.00" at the end
```

### Bonus scenario 4 — concurrency

**Case A — the unique index (same reference):**
```text
for (let i = 0; i < 5; i++) {
  fresh bill, fresh ref
  const [a, b] = await Promise.all([post(ref, "40.00"), post(ref, "40.00")])
  assert [a.status, b.status].sort() === [200, 201]
  assert payments count === 1
  assert PAYMENT_RECEIVED count === 1
  assert balance === "60.00"
}
```
Looping matters: a single pass can pass by luck if the requests happen not to overlap.

**Case B — the row lock (different references):**
```text
bill of 100.00
Promise.all([ post(refX, "60.00"), post(refY, "40.00") ])
assert both 201
assert balance === "0.00"
assert status === 'PAID'
assert 3 ledger entries
```
Case B fails if `FOR UPDATE` is missing — a lost status update. Case A fails if the unique index is missing. **Both are needed; they fail for different reasons**, and shipping only one leaves half the concurrency claim unproven.

### API / additional cases

| Scenario | Action | Expected |
|---|---|---|
| Double post | `POST /bills/:id/post` twice | 409 `INVALID_BILL_STATE`; exactly one `BILL_POSTED` entry |
| Payment on DRAFT | pay an unposted bill | 409; zero payment rows written |
| Payment on VOID | pay a voided bill | 409 |
| Payment on PAID | pay a fully paid bill | 409 |
| Void with payments | `POST /bills/:id/void` on a POSTED bill that has a payment | 409 `BILL_HAS_PAYMENTS` |
| Void a draft | `POST /bills/:id/void` on DRAFT | 200, status VOID |
| Overpay | pay `"150.00"` on a 100.00 bill | 200/201, status PAID, balance `"-50.00"` |
| Reverse then replay | reverse, then resubmit the same ref | **200, no new credit, balance unchanged.** The sharpest case in the suite — it is where the unconditional unique index and the `withDeleted` re-read are both proven |
| Double reverse | `DELETE` the same payment twice | 404 the second time, **not 500** (C1) |
| Float ingress | `{"amount": 40.5}` | 400 |
| Too many decimals | `{"amount": "40.555"}` | 400 |
| Zero / negative | `{"amount": "0"}` / `"-5.00"` | 400 |
| Unknown field | `{"amount":"10.00","foo":1}` | 400 (`forbidNonWhitelisted`) |
| Missing header | omit `X-Org-Id` | 400 `MISSING_ORG_CONTEXT` |
| Malformed header | `X-Org-Id: not-a-uuid` | 400 `INVALID_ORG_CONTEXT` |
| Unknown org | a valid UUID for a non-existent org | 404 on every resource — identical to another tenant's |
| Malformed path id | `GET /bills/abc` | 400 |
| DRAFT balance | `GET` a draft bill | `"0.00"` — not `null`, not `"0"` |

### AI slice tests

| Scenario | Expected |
|---|---|
| Stub returns a valid suggestion | 200, `suggestion.billId` ∈ candidates, `llmAvailable: true` |
| Stub throws | 200, candidates still present, `llmAvailable: false`, `warning` set — **never 5xx** |
| Stub exceeds the timeout | 200, same fallback |
| Stub returns malformed JSON | 200, suggestion dropped |
| Stub returns a `billId` outside the shortlist | 200, suggestion dropped, candidates intact |
| **After every case above** | `payments` and `ledger_entries` counts unchanged — the B12 assertion |
| Another tenant's bills | never appear in candidates |

### Regression guard (worth five minutes)

`no-forbidden.e2e-spec.ts` — drive every endpoint with another tenant's resource id and assert no response is ever 403. This converts the "404, never 403" rule from a convention into something the suite enforces against future edits. Pair it with a grep in the final sweep.

---

## 13. Error Handling

Uniform body: `{ statusCode, code, message }`. `code` is stable and machine-readable; `message` is human-readable and never contains a driver error or another tenant's data.

### Business-rule failures

| Scenario | Cause | Status / code | Message | Logging | Recovery |
|---|---|---|---|---|---|
| Missing `X-Org-Id` | Client or gateway misconfiguration | 400 `MISSING_ORG_CONTEXT` | "X-Org-Id header is required" | warn, no body | Client adds the header |
| Malformed `X-Org-Id` | Not a UUID | 400 `INVALID_ORG_CONTEXT` | "X-Org-Id must be a valid UUID" | warn | — |
| Money validation failure | Float, too many decimals, ≤ 0, non-string | 400 `VALIDATION_FAILED` | Field-level detail from `class-validator` | debug | Client corrects the payload |
| Bill not found / another tenant's | Wrong id, or cross-tenant access | 404 `NOT_FOUND` | "Bill not found" | info with `orgId` and the id | **Byte-identical in both cases — intentional** |
| Payment not found / already reversed | Soft-deleted rows are invisible to the tenant | 404 `NOT_FOUND` | "Payment not found" | info | — |
| Illegal transition | Post a POSTED bill, void a PAID bill | 409 `INVALID_BILL_STATE` | "Bill is in state POSTED and cannot be posted" | info | Client re-reads the bill |
| Payment on a non-POSTED bill | B8 | 409 `INVALID_BILL_STATE` | "Payments are only accepted on posted bills" | info | Post the bill first |
| Void with payments | B1 | 409 `BILL_HAS_PAYMENTS` | "Cannot void a bill that has payments" | info | Reverse the payments first |
| Duplicate `externalRef` | Processor retry | **Not an error** — 200 with the existing payment and `replayed: true` | — | info with `orgId` and `externalRef` | None needed; this is the designed path |
| Replay with a different amount | Upstream inconsistency | 200 + `warning: 'AMOUNT_MISMATCH_ON_REPLAY'` | — | **warn** — this indicates a real upstream bug and should be visible | Investigate upstream; no money moved |

### Technical failures

| Scenario | Cause | Behaviour | Logging | Recovery |
|---|---|---|---|---|
| `23505` on `payments_org_external_ref_uq` | Concurrent identical ingestion | Roll back, re-read in a fresh transaction, return 200 | info | Automatic |
| `23505` on any other constraint | A genuine invariant breach (e.g. double `BILL_POSTED`) | **Rethrow → 500** | **error, with the constraint name** | Loud on purpose. Silently swallowing this would hide a real bug (C5) |
| `23514` (CHECK violation) | Wrong-signed ledger amount — a service bug | 500 | error | Fix the code; the database prevented the corruption |
| `23503` (FK violation) | Cross-tenant row attempted | 500 | error | The composite FK did its job; investigate the code path |
| `40P01` (deadlock) | Inconsistent lock ordering | 500 | error | Should be unreachable: the bill is always locked first (R1). If it appears, the lock-order invariant has been broken — treat it as a defect, not as noise to retry away |
| Database unavailable | Container down, network failure | 503 `SERVICE_UNAVAILABLE`, **no partial write** | error | Transactions guarantee all-or-nothing |
| Provider timeout / error / bad JSON | Model unavailable or misbehaving | **200** with deterministic candidates and `llmAvailable: false` | warn | Graceful degradation — never a 5xx (N7) |
| Hallucinated `billId` | Model returned an id outside the shortlist | Suggestion dropped, candidates returned, warning set | warn | The cashier never sees an invented match |
| Unhandled exception | Anything else | 500 `INTERNAL_ERROR`, generic message | error with the full stack, server-side only | The filter never echoes a driver message to the client |

**Transactional guarantee.** Every money-mutating path runs inside a single `dataSource.transaction`. A failure at any point leaves no partial ledger row, no orphan payment, and no half-applied status change. The isolation spec asserts this by snapshotting row counts around rejected requests.

---

## 14. Security & Permissions

**Authentication.** None, by assignment. `X-Org-Id` is trusted as though set by an authenticated upstream gateway.

**This assumption is stated in three places** — the README, DECISIONS.md, and a comment in `tenant.middleware.ts` — because an untrusted tenant header in production code is a critical vulnerability. The reviewer needs to see the difference between "not required for this exercise" and "not understood".

**Authorisation.** Tenancy *is* the authorisation model here. There are no roles. Every tenant-scoped lookup passes through `TenantScope`, which throws `NotFoundException` and nothing else.

**Where the checks happen.**

| Layer | Check |
|---|---|
| Middleware | `X-Org-Id` present and a well-formed UUID. Never verifies existence — a valid-but-unknown org must be indistinguishable from another tenant's org |
| Controller | `@OrgId()` in every signature, passed explicitly to the service. Deliberately verbose so a missing scope is visible in a diff |
| Service | Every lookup goes through `TenantScope.*OrThrow` |
| Database | Composite foreign keys make a cross-tenant row physically unrepresentable |

**404, never 403 — and why it matters.** Returning 403 confirms that a resource exists, which lets any tenant enumerate another tenant's identifiers. Returning an identical 404 for "does not exist" and "belongs to someone else" leaks nothing. Enforced by `TenantScope`, asserted by `no-forbidden.e2e-spec.ts`, and confirmed by a grep in the final sweep.

**Input validation.** Global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`. All database access is via TypeORM parameterized queries or explicitly parameterized raw SQL — **no string interpolation into SQL anywhere**, including the AI shortlist query, which takes the parsed amount as a bound parameter.

**Secrets.** `ANTHROPIC_API_KEY` from the environment only. `.env` is gitignored **before the first commit** — adding it later leaves the key in history. Final check: `git log -p | grep -i -E 'api[_-]?key|secret|sk-ant'`.

**Data sent to the AI provider.** The prompt contains a bank line supplied by the user plus bill amounts and identifiers for **one** organization. It never contains data from another tenant, and never contains credentials. Worth one line in DECISIONS.md — in a real deployment this is a data-processing question requiring a customer agreement, and noticing that is part of the product judgment being assessed.

**Logging.** `orgId`, entity identifiers, and `externalRef` are logged; **amounts are not** (N11). One structured line per completed money transaction.

**Audit trail.** The ledger is append-only and complete: every money movement, including corrections, is a row. The acknowledged gap is that a reversed payment becomes invisible to the tenant via the API (A4); the administrative read path with `withDeleted: true` is named as future work.

---

## 15. Performance & Scalability Considerations

**No special performance work is required for this assignment, and none should be done.** The dataset is a handful of test rows and the graded property is correctness. Premature optimisation here would actively cost points by obscuring the logic.

That said, the design already avoids the traps that would matter, and being able to name them is worth more than optimising them:

| Concern | Status |
|---|---|
| **N+1 in the AI shortlist** | Avoided by design — one query with `LEFT JOIN LATERAL` computes each candidate's balance (C6). This is the only place in the build where a naive implementation would produce N+1 |
| **Balance recomputation** | `SUM` over one bill's ledger entries, served by `INDEX (org_id, bill_id, created_at)`. Bounded by payments-per-bill, which is small in this domain |
| **`balance` and `amountPaid` in one round trip** | A single query with `FILTER (WHERE …)` rather than two queries (§8.6) |
| **Status recompute** | A single `UPDATE … CASE WHEN (SELECT SUM …)`. One statement, no read-then-write round trip, and no balance value in TypeScript (R2) |
| **Lock contention** | `FOR UPDATE` on the bill serializes concurrent payments *for that bill only*. Different bills never contend. Correct trade: contention is per-bill and bills are the natural unit of serialization |
| **Transaction scope** | Every transaction is a handful of statements against a single bill's rows. No long-running transactions, no user input awaited inside a transaction |
| **Connection pool** | `max: 10`. Below 5 the concurrency spec silently serializes and stops proving anything |
| **AI latency** | Bounded by a 3s `AbortController`, on a separate endpoint. The money path never waits on a model |
| **Pagination** | Not applicable — there are no list endpoints in scope |

**Where this design stops scaling, and the answer** (DECISIONS.md, not code): once a bill accumulates thousands of ledger entries, recomputing `SUM` on every read becomes the bottleneck. The answer is a denormalized `bills.balance` column updated **inside the same transaction** as the ledger append, with the ledger remaining the source of truth and a periodic reconciliation job asserting the two agree. It is deliberately deferred because derived-from-ledger is more provably correct, and provable correctness is what this exercise is measuring.

---

## 16. Migration / Deployment Considerations

**Database migrations.** Two, both hand-written, both run by `npm run migration:run`:

1. `Init` — all four tables with every constraint and index.
2. `SeedOrgs` — two organizations with fixed UUIDs.

`synchronize: false` throughout. TypeORM must never alter the schema at boot; the migrations are the only source of schema truth.

**Environment variables.**

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Application database | — (required) |
| `TEST_DATABASE_URL` | e2e database — **must be a different database**, since the harness truncates every table | — (required for tests) |
| `PORT` | HTTP port | `3000` |
| `LLM_PROVIDER` | `stub` or `anthropic` | `stub` |
| `ANTHROPIC_API_KEY` | Only when `LLM_PROVIDER=anthropic` | empty |
| `LLM_TIMEOUT_MS` | Abort threshold | `3000` |

`.env.example` is committed with every key and no values. `.env` is gitignored from the first commit.

**Deployment sequencing.** Not applicable — there is no running system and no existing data. For completeness, the order a reviewer will follow is: start Postgres → create both databases → run migrations → start the application or the suite.

**Feature flags.** One, effectively: `LLM_PROVIDER`. It defaults to `stub`, so the application runs fully with no API key. That is deliberate — the reviewer must be able to run everything without obtaining credentials.

**Backward compatibility.** Not applicable. Greenfield.

**Rollback.** Every migration has a working `down()`. `npm run migration:revert` reverses the last one. Rarely needed here, but a migration without a tested `down()` is incomplete work.

**The one deployment risk that actually applies:** a migration chain that works against the incrementally-built local database but fails against a fresh one. **Mitigation is mandatory, not optional** — as the first action of Step 10, drop the database entirely, run the full chain, and run the full suite. This is the most common cause of a submission that does not start on the reviewer's machine.

**`TO VERIFY` before starting:**

- Node.js version and package manager (npm assumed throughout).
- The Postgres image tag (`postgres:15` assumed; `gen_random_uuid()` is built in from 13 onward — if an older image is used, add `CREATE EXTENSION IF NOT EXISTS pgcrypto`).
- How `billing_test` gets created — a `db:create-test` script, or a documented `psql` line in the README. Do not leave this implicit; a reviewer hitting a missing test database will stop there.

---

## 17. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| `numeric` silently parsed into a JS number | Critical — fails N1, silent cents loss | Low | Never register a pg numeric parser; comment saying so; assert `typeof === 'string'` in the specs |
| TypeORM's in-memory entity returns a `numeric` field in an unexpected shape after `save()` | High — wrong response body | Medium | Map every response through an explicit DTO; re-read after write where there is any doubt |
| A forgotten `org_id` filter in one query | Critical — fails the headline requirement | Medium | Route every lookup through `TenantScope`; composite FKs as the backstop; the isolation spec |
| Check-then-insert idempotency | Critical — double credit under race | Medium | Insert-first + constraint-name-discriminated `23505` handling |
| Catching `23505` and continuing **inside** the same transaction | High — every later statement errors; misleading failure | **High** — this is the single most common implementation error in this pattern | Roll back, re-read in a **new** transaction; call it out in a code comment |
| Catching `23505` too broadly | High — a real invariant breach returns 200 | Medium | Discriminate on `error.constraint` (C5) |
| Missing `FOR UPDATE` | High — lost status update when two payments land together | Medium | Lock the bill first in every money transaction; concurrency Case B proves it |
| Reversal race producing a 500 instead of a 404 | Medium | Medium | Re-select the payment `FOR UPDATE` inside the bill lock (C1) |
| Deadlock from inconsistent lock order | Medium | Low | Always lock the bill before touching payments or ledger rows (R1) |
| Soft-delete / unique-index interaction | High — replay after reversal either 404s or re-credits | Medium | Unconditional unique index + `withDeleted` on the replay re-read; documented semantics; a dedicated test |
| `@DeleteDateColumn` silently filtering ledger reads | Critical — wrong balance, silently | Medium | **`ledger_entries` has no `deleted_at` at all** (C2) |
| Balance computed from `payments` instead of `ledger_entries` | Critical — reversal breaks reconciliation | Medium | `LedgerService.balanceFor()` is the only balance source, with a comment forbidding the join |
| Concurrency spec flaky, or serialized by a size-1 pool | Medium — the bonus test proves nothing | Medium | Pool ≥ 5; `app.listen(0)`; loop the test; assert both status codes were observed |
| Test pollution between specs | Medium — order-dependent failures | Medium | Truncate and reseed in `beforeEach`; `--runInBand` |
| `migration:generate` drifting from the hand-written SQL | High — the schema does not reproduce | Medium | Write the init migration by hand; verify against a freshly dropped database before submitting |
| Model latency in the request path | Low | Medium | 3s abort, deterministic fallback, separate endpoint |
| Model hallucinating a `billId` | Medium — a cashier shown a wrong match | Medium | Validate `billId ∈ shortlist`; drop the suggestion otherwise |
| A committed API key | Critical — instant negative signal | Low | `.env` gitignored before commit 1; `.env.example` only; grep history before submitting |
| Scope creep on the AI slice | Medium — the core suffers | **High** | Hard 45-minute timebox; stub first; the real client is optional and documented as such |
| Over-abstraction hurting the live-extension exercise | Medium — cannot explain own code | Medium | Explicit `EntityManager` passing; no async-local magic; no repository layer over TypeORM |
| Running out of time | High | Medium | Build in the stated order. Steps 1–8 are the graded core; Step 9 is independent after Step 5 and can be reduced to the interface plus stub without losing the design point |

---

## 18. Definition of Done

### Functional

- [ ] All six endpoints behave per the §8 contracts
- [ ] `DRAFT → POSTED → PAID`, `DRAFT → VOID`, `POSTED → VOID` (no payments), `PAID → POSTED` on reversal; every other transition is 409
- [ ] Replay of an `externalRef` returns 200 with one payment and one credit entry
- [ ] Reversal appends `PAYMENT_REVERSED`, soft-deletes the payment, and reopens the bill
- [ ] `GET /bills/:id` returns `balance` and `amountPaid` derived from the ledger
- [ ] `POST /reconciliation/suggest` returns candidates and a suggestion, and degrades gracefully

### Invariants

- [ ] Cross-tenant access returns 404 on every endpoint, with **zero rows written**
- [ ] `ForbiddenException` appears nowhere in `src/` (grep-confirmed **and** test-enforced)
- [ ] Money is `numeric(12,2)` in the database and a two-decimal string in every JSON field, both directions
- [ ] No `parseFloat`, no `Number(`, no arithmetic on money in TypeScript (grep-confirmed)
- [ ] Every money mutation runs in one transaction with the bill row locked first
- [ ] `SUM(ledger.amount)` equals the reported balance in every lifecycle assertion
- [ ] No hard deletes; `deleted_at` on organizations, bills, and payments; `ledger_entries` is append-only with no `deleted_at`
- [ ] `LedgerService` is the only writer of `ledger_entries` and the only source of a balance

### AI slice

- [ ] Behind `LlmClient`; the stub is the default binding and the application runs with no API key
- [ ] Timeout plus graceful degradation; the endpoint never returns 5xx because of the provider
- [ ] Suggests only — a test asserts zero writes to `payments` and `ledger_entries`
- [ ] The suggested `billId` is validated against the shortlist
- [ ] Amount parsing is deterministic and in code, never delegated to the model
- [ ] No key in the repository or in git history

### Tests

- [ ] Three required scenarios plus the concurrency bonus, all green
- [ ] Concurrency covers **both** the same-reference case and the different-references case
- [ ] The suite passes on a database created from migrations alone
- [ ] The concurrency spec is looped and non-flaky across five consecutive runs
- [ ] The isolation spec asserts row counts, not merely status codes

### Quality and documentation

- [ ] `tsc --noEmit` clean; lint clean; `synchronize: false`
- [ ] README: `docker run` Postgres, create the test database, `npm run migration:run`, `npm run test:e2e` — verified verbatim on a clean machine
- [ ] DECISIONS.md ≤ 1 page covering: numeric-not-float, the idempotency mechanism, isolation and why 404, reversal balance math, the AI feature and guardrails, and one-thing-differently (RLS + a denormalized balance cache)
- [ ] Assumptions stated in the README: trusted header, seeded organizations, single currency, immutable `amountDue`, no partial reversals
- [ ] Conventional commits, roughly ten, each independently defensible — no `wip`, no `fix stuff`
- [ ] A manual curl walkthrough of the full lifecycle performed once by hand

---

## 19. Project Owner Summary

### What are we changing?

We are building a small billing service from scratch. It lets several customer organizations share one system while keeping their data completely separate, records what each customer owes, accepts payments against those bills, and allows a mistaken payment to be reversed without erasing any history. It also adds an AI-assisted helper that suggests which bill an unmatched bank transfer probably belongs to.

### Why are we changing it?

Three problems break billing systems in production, and all three are silent until the damage is done:

1. **One customer seeing another customer's data.** That is a breach, not a bug.
2. **The same payment being counted twice.** Payment processors legitimately retry their notifications; a system that treats each retry as new money credits customers for payments they never made.
3. **Corrections that destroy the record.** If reversing a payment simply deletes it, nobody can later explain what happened or prove the books are right.

### How will it work?

A bill starts as a draft. Posting it makes it real and records what is owed. Payments reduce the balance; when the balance reaches zero the bill is marked paid. Reversing a payment adds a correcting entry rather than deleting anything, and the bill reopens.

The key idea is that **the balance is never stored — it is always recalculated from the list of recorded movements.** Every movement, including every correction, is a permanent line in that list. Adding them up gives the balance. There is no separate number that can drift out of date, and no correction that leaves a gap.

### Why did we choose this approach?

- **The database enforces the rules, not just the code.** Separation between customers, valid amounts, and the "one payment per processor reference" rule are all enforced by the database itself. Even a future coding mistake cannot break them.
- **Money is handled as exact decimal text throughout.** Ordinary computer decimal arithmetic loses fractions of a cent; at billing volumes those add up to real, unexplainable discrepancies. This design makes that impossible.
- **Duplicate payments are prevented by the database's own uniqueness guarantee**, not by a code check. A code check can be defeated by two notifications arriving at the same instant — which is exactly when processors retry.
- **The AI only suggests.** It never records a payment. A person always makes the final decision.

### What is included?

Creating, posting, voiding, and viewing bills; recording payments safely including duplicate retries; reversing payments; a live balance for each bill; the AI matching suggestion; a full automated test suite covering separation, duplicates, the complete lifecycle, and simultaneous requests; and documentation explaining every decision.

### What is not included?

Login and user accounts (the assignment specifies an existing authentication layer upstream). Creating or managing organizations. Multiple currencies. Refunding money back to the card or bank. Any user interface. Partial reversals — a payment is reversed in full or not at all.

### What are the risks?

| Risk | How it is handled |
|---|---|
| A duplicate payment slips through under exact simultaneity | The database, not the code, enforces uniqueness — and there is a test that fires two identical requests at the same instant, repeatedly |
| A rounding error in money | Exact decimal storage; no ordinary decimal arithmetic anywhere; tests assert exact amounts down to the cent |
| One customer's data visible to another | Enforced at two independent layers, and tested by attempting the access and confirming both the refusal and that nothing was written |
| The AI suggests a wrong or invented bill | Every suggestion is checked against a list the system itself produced; anything outside it is discarded before a person sees it |
| The AI service is slow or unavailable | It is cut off after three seconds and the user still receives the system's own ranked shortlist. The feature degrades; it does not disappear |
| The build runs out of time | The AI helper is the last piece and is independent. Everything graded as core is complete before it starts |

### What will the user experience?

A cashier records a payment and immediately sees the updated balance. If the payment processor sends the same notification twice, nothing changes and no error is shown — the second one is quietly recognised as a repeat. If a payment was recorded in error, the cashier reverses it: the balance returns to what it was, the bill reopens, and the original record remains visible in the ledger for audit. When a bank transfer arrives that does not obviously belong to any bill, the cashier pastes the line in and gets a ranked list of likely matches with a plain-language explanation — then decides for themselves.

---

## 20. Developer Quick Start

```text
 1. Read analysis/04-technical-approach.md and section 0 of this document (the corrections)
 2. Scaffold + data-source (synchronize: false)         → commit
 3. Entities + hand-written init migration + seed       → commit
 4. Money helper + @IsMoneyString                       → commit
 5. Tenant middleware + TenantScope + exception filter  → commit
 6. LedgerService + bills (create/post/void/get)        → commit
 7. Payments: idempotent ingestion                      → commit
 8. Payments: reversal                                  → commit
 9. Test suite (isolation, idempotency, lifecycle, concurrency)  → commit
10. AI reconciliation slice                             → commit
11. DROP the database, migrate, run the whole suite
12. README + DECISIONS.md, lint, type-check, secret sweep → commit
```

Steps 2–8 are strictly sequential. Step 10 depends only on step 6 and can move earlier if the schedule slips.

### Files Expected to Change

None — greenfield.

### Files Expected to Be Added

```text
package.json  tsconfig.json  .gitignore  .env.example  README.md  DECISIONS.md
src/main.ts
src/app.module.ts
src/database/data-source.ts
src/database/migrations/<ts>-Init.ts
src/database/migrations/<ts>-SeedOrgs.ts
src/common/tenant/{tenant.middleware.ts,org-id.decorator.ts,tenant-scope.service.ts}
src/common/money/{money.ts,money.spec.ts,is-money-string.validator.ts}
src/common/filters/all-exceptions.filter.ts
src/common/health/health.controller.ts
src/organizations/organization.entity.ts
src/bills/{bill.entity.ts,bills.service.ts,bills.controller.ts,bills.module.ts}
src/bills/dto/{create-bill.dto.ts,bill-response.dto.ts}
src/payments/{payment.entity.ts,payments.service.ts,payments.controller.ts,payments.module.ts}
src/payments/dto/{create-payment.dto.ts,payment-response.dto.ts}
src/ledger/{ledger-entry.entity.ts,ledger.service.ts,ledger.module.ts}
src/llm/{llm-client.interface.ts,stub-llm.client.ts,anthropic-llm.client.ts,llm.module.ts}
src/reconciliation/{reconciliation.service.ts,reconciliation.controller.ts,reconciliation.module.ts}
src/reconciliation/dto/{suggest-request.dto.ts,suggest-response.dto.ts}
test/jest-e2e.json
test/helpers/{app.ts,db.ts,fixtures.ts}
test/{tenant-isolation,idempotency,ledger-lifecycle,concurrency,reconciliation,no-forbidden}.e2e-spec.ts
```

### Files Expected to Be Deleted

None. (Remove the `nest new` sample `app.controller.ts` / `app.service.ts` / `app.controller.spec.ts` if the generator creates them — otherwise none.)

### Commands to Run

```bash
# Postgres — TO VERIFY the image tag against the assignment's setup hint
docker run --name billing-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:15

# Test database — TO VERIFY the exact form; must exist before the suite runs
docker exec -it billing-pg psql -U postgres -c 'CREATE DATABASE billing_test'

npm install
npm run migration:run       # TO VERIFY — script defined in Step 1
npm run start:dev
npm run test:e2e            # TO VERIFY — script defined in Step 1
npm run typecheck
npm run lint                # TO VERIFY — depends on whether nest new adds eslint
```

All npm scripts above are **proposed** and defined in Step 1; they do not exist yet.

### Final sweep before submitting

```bash
grep -rn "parseFloat\|Number(\|ForbiddenException\|synchronize: true" src/     # must be empty
grep -rn "deleted_at" src/ledger/                                              # must be empty
git log -p | grep -i -E 'api[_-]?key|secret|sk-ant'                            # must be empty
git log --oneline                                                              # ~10 conventional commits
```

---

## 21. Final Implementation Checklist

Working checklist — tick as you go.

**Understand**
- [ ] Read section 0 of this document (corrections to the prior analysis) before writing code
- [ ] Re-read the original assignment brief and diff it against the §5 traceability table
- [ ] Confirm Postgres is reachable and the image tag is correct
- [ ] Fix the ambiguity decisions in writing — they become DECISIONS.md

**Data**
- [ ] Four entities with explicit column names and money typed `string`
- [ ] Init migration hand-written with every `CHECK`, both composite foreign keys, `payments_org_external_ref_uq` by that exact name, and both partial unique indexes
- [ ] `ledger_entries` has no `deleted_at` and no `@DeleteDateColumn`
- [ ] Seed migration with fixed organization UUIDs
- [ ] The three by-hand constraint-rejection checks from Step 2 all fail as intended

**Backend**
- [ ] `Money` helper and `@IsMoneyString()` — a JSON number is rejected
- [ ] Tenant middleware, `@OrgId()`, `TenantScope` — `NotFoundException` only
- [ ] `LedgerService` — `append`, `balanceFor`, `recomputeBillStatus`; no update or delete method
- [ ] Bills: create, post (transactional, locked), void, get
- [ ] Payments: idempotent ingestion — insert-first, constraint-name discrimination, fresh-transaction replay re-read with `withDeleted`
- [ ] Payments: reversal — payment re-selected `FOR UPDATE` **inside** the bill lock
- [ ] The controller sets 201 or 200 dynamically on `POST /payments`
- [ ] AI slice — interface, stub default, deterministic parse and shortlist, `billId` validated against the shortlist, 3s abort

**Cross-cutting**
- [ ] Global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`
- [ ] Global exception filter emitting `{ statusCode, code, message }`, never echoing driver errors
- [ ] Structured logging with `orgId`, never amounts
- [ ] The bill is locked first in **every** money transaction

**Tests**
- [ ] Harness: migrations in `globalSetup`, truncate and reseed in `beforeEach`, `app.listen(0)`, pool ≥ 5
- [ ] Isolation spec asserts **row counts unchanged**, not just the 404
- [ ] Idempotency spec covers replay, amount-mismatch replay, and cross-org same-reference
- [ ] Lifecycle spec asserts `SUM(amount)`, entry order, the untouched original row, and exact string formatting
- [ ] Concurrency spec covers both the same-reference and different-references cases, looped
- [ ] Reconciliation spec asserts zero writes
- [ ] `no-forbidden` guard spec present
- [ ] The reverse-then-replay case is tested — the sharpest case in the suite

**Verify**
- [ ] `npm run test:e2e` green five consecutive times
- [ ] `tsc --noEmit` clean, lint clean
- [ ] **Database dropped, migrations re-run from scratch, full suite green**
- [ ] Manual curl walkthrough of the full lifecycle
- [ ] The final grep sweep from §20 is clean

**Ship**
- [ ] README verified verbatim by following it as a stranger would
- [ ] DECISIONS.md ≤ 1 page, all six points, written from the code that exists
- [ ] Conventional commit history reviewed
- [ ] No secrets anywhere in history
- [ ] Rehearse the two hardest live questions: *"walk me through two simultaneous webhooks"* and *"why 404 and not 403"*
