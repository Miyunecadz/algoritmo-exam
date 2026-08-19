# Detailed Step-by-Step Implementation Plan

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers section 10.

[← API / Backend Changes & Client Flows](./05-api-and-flows.md) · [Index](./README.md) · [Developer Task Breakdown →](./07-task-breakdown.md)

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
   DATABASE_URL=postgres://postgres:pg@localhost:5432/billing
   TEST_DATABASE_URL=postgres://postgres:pg@localhost:5432/billing_test
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
   "db:up": "docker run --name tt-pg -e POSTGRES_PASSWORD=pg -p 5432:5432 -d postgres:15",
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

**Objective.** The complete schema, with every constraint from [§7](./04-codebase-and-data-model.md), created by a hand-written migration.

**Changes**

- Four entity files.
- `src/database/migrations/<ts>-Init.ts`.
- `src/database/migrations/<ts>-SeedOrgs.ts`.

**Implementation**

1. Write the entities with an explicit `name:` on **every** column (`snake_case` in the database, `camelCase` in TypeScript).
   - Money columns: `@Column({ type: 'numeric', precision: 12, scale: 2, name: 'amount' }) amount!: string;` — note the TypeScript type is `string`.
   - `@DeleteDateColumn({ name: 'deleted_at' })` on `Organization`, `Bill`, `Payment`.
   - **`LedgerEntry` gets neither `deleted_at` nor `updated_at`** ([C2](./00-critical-review.md)).
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
3. `toMinor` exists for unit-testable comparisons only. **No `add`, no `compare`** ([T1](./00-critical-review.md)) — SQL performs both.
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

1. `LedgerService.append(manager, { orgId, billId, paymentId?, type, amount })` — a plain insert. **The only writer of `ledger_entries` in the codebase** ([R3](./00-critical-review.md)). No update or delete method exists; do not add one.
2. `LedgerService.balanceFor(manager, orgId, billId): Promise<string>`:
   ```sql
   SELECT COALESCE(SUM(amount), 0)::numeric(12,2)::text AS balance,
          (-1 * COALESCE(SUM(amount) FILTER (
              WHERE type IN ('PAYMENT_RECEIVED','PAYMENT_REVERSED')), 0))::numeric(12,2)::text
          AS amount_paid
   FROM ledger_entries WHERE bill_id = $1 AND org_id = $2
   ```
   One round trip returns both fields ([§8.6](./05-api-and-flows.md), [C3](./00-critical-review.md)). **Add the comment: this query must never join to `payments` or filter on `payments.deleted_at`.**
3. `LedgerService.recomputeBillStatus(manager, orgId, billId)` — the single `UPDATE … CASE WHEN` from [§8.4](./05-api-and-flows.md), including the `status IN ('POSTED','PAID')` guard ([C7](./00-critical-review.md)). No balance value enters TypeScript ([R2](./00-critical-review.md)).
4. `BillsService.create` — one insert, no transaction.
5. `BillsService.post` — `dataSource.transaction(...)`: lock → assert DRAFT → append `+amountDue` → update status and `posted_at` → map the response.
6. `BillsService.void` — transaction: lock → allow DRAFT→VOID; POSTED→VOID only when `COUNT(payments WHERE deleted_at IS NULL) = 0`; else 409.
7. `BillsService.findOne` — `TenantScope.findBillOrThrow` + `balanceFor`.
8. One `BillResponseDto` and one mapper used by **all four** bill endpoints ([§0.4](./00-critical-review.md)).
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

1. Implement transaction 1 exactly as [§8.4](./05-api-and-flows.md): lock the bill → assert POSTED → insert the payment → append the negative credit → `recomputeBillStatus`.
2. Wrap the transaction in a `try/catch`. In the catch:
   - Narrow to a driver error with `code === '23505'`.
   - **If `error.constraint !== 'payments_org_external_ref_uq'`, rethrow** ([C5](./00-critical-review.md)).
   - Otherwise call a separate `resolveReplay(orgId, externalRef)` method that opens its **own** transaction (or uses the plain repository) and re-reads with `withDeleted: true`.
3. Compare the submitted amount to the stored amount; on mismatch set `warning: 'AMOUNT_MISMATCH_ON_REPLAY'` ([C4](./00-critical-review.md)). Never create a second credit.
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

1. Implement [§8.5](./05-api-and-flows.md) with the **corrected ordering** ([C1](./00-critical-review.md)): resolve `bill_id` → lock the bill → **re-select the payment `FOR UPDATE` and re-check `deleted_at IS NULL` inside the lock** → append `+amount` with `payment_id` → set `deleted_at` → `recomputeBillStatus`.
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
5. Write the specs in the order of [§12](./08-testing-plan.md): isolation → idempotency → lifecycle → concurrency → reconciliation → the no-`ForbiddenException` guard.
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
   - The shortlist query from [§8.7](./05-api-and-flows.md) — one query, `LEFT JOIN LATERAL`, limit 5.
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
   docker rm -f tt-pg && npm run db:up
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
4. `npm run lint`, `npm run typecheck`, and the grep sweep from [§21](./13-quick-start-and-checklist.md).
5. `git log -p | grep -i -E 'api[_-]?key|secret|sk-ant'` — must be empty.

**Reason.** A submission that does not start on the reviewer's machine loses more than any missing feature. And the reasoning is what is being graded — DECISIONS.md is where it lives.

**Dependencies.** All prior steps.

**Expected result.** A clean clone plus three commands produces a green suite.

**Verification.** Read the README as a stranger and execute the commands verbatim, without improvising.

**Commits.** `docs: add readme and decisions`, `chore: lint and type-check clean`

---

---

[← API / Backend Changes & Client Flows](./05-api-and-flows.md) · [Index](./README.md) · [Developer Task Breakdown →](./07-task-breakdown.md)
