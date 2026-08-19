# 4. Recommended Technical Approach

> Part 4 of the [Mini Billing Ledger analysis](./README.md).

## 4.1 Money — approach comparison

| Option | Verdict |
|---|---|
| `numeric(12,2)` + `string` in TS, arithmetic delegated to Postgres `SUM` | ✅ **Recommended.** Zero precision risk, no dep, and balance is one query |
| `numeric` + `decimal.js` for all TS math | Overkill here; adds dep for comparisons the DB already does |
| `bigint` minor units in DB | Diverges from assignment's explicit `numeric(12,2)` |
| JS `number` anywhere | Disqualifying |

Implementation notes:

- Column: `@Column({ type: 'numeric', precision: 12, scale: 2, name: 'amount' }) amount!: string;`
- `node-postgres` returns `numeric` as string by default. **Do not** register a numeric type parser. Add a comment saying so — this is the exact trap.
- Tiny `Money` helper: `toMinor(s): bigint`, `fromMinor(b): string`, `compare`, `add`, `negate`. Used only for comparisons/sign flips in TS. All aggregation in SQL.
- Balance query returns string: `COALESCE(SUM(amount), 0)::numeric(12,2)::text`.

## 4.2 Tenant isolation — approach comparison

| Option | Verdict |
|---|---|
| Manual `where: { orgId }` everywhere | Works, but one forgotten clause = the exact bug being graded |
| Scoped-query helper + `NotFoundException` on miss + composite FK in schema | ✅ **Recommended.** Single choke point, DB-level backstop, explainable in 60s |
| Postgres RLS with `SET LOCAL app.current_org` | Strongest. Too much setup risk for 4–6h → DECISIONS.md future work |
| TypeORM global subscriber rewriting queries | Fragile, hard to explain live |

Design:

- `TenantMiddleware` reads + validates `X-Org-Id`, attaches to `req.orgId`.
- `@OrgId()` param decorator feeds it to controllers explicitly — visible in every signature, so a missing scope is visible in review.
- `TenantScope` service: `findBillOrThrow(manager, orgId, billId)` etc. Every miss throws `NotFoundException`. **No code path returns 403 for cross-org** — grep-able invariant.
- Schema backstop: `bills` gets `UNIQUE (org_id, id)`; `payments (org_id, bill_id)` and `ledger_entries (org_id, bill_id)` reference it. A cross-tenant row physically cannot be inserted.

## 4.3 Idempotency

```
BEGIN
  bill = SELECT … FROM bills WHERE id=$1 AND org_id=$2 FOR UPDATE   -- 404 if miss
  assert bill.status = 'POSTED'                                     -- else 409
  INSERT INTO payments (org_id, bill_id, amount, external_ref) …    -- may raise 23505
  INSERT INTO ledger_entries (…, 'PAYMENT_RECEIVED', -amount)
  balance = SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE bill_id=… AND org_id=…
  IF balance <= 0 THEN UPDATE bills SET status='PAID' …
COMMIT                                                              -- 201
```

On `23505` (constraint `payments_org_external_ref_uq`): roll back, then in a **fresh** transaction re-read by `(org_id, external_ref)` and return it with 200. Include `withDeleted: true` on that re-read so replay-after-reversal resolves instead of 404-ing.

Why insert-first-catch-violation beats check-then-insert: the check-then-insert window is exactly what two simultaneous webhooks exploit. The unique index is the only real serialization point.

Defense in depth: partial unique index `ledger_entries (payment_id, type) WHERE payment_id IS NOT NULL` — makes double-credit unrepresentable even if service logic regresses.

`FOR UPDATE` on the bill also fixes the *different*-payments-same-bill race (edge case 4), which the unique index does not cover. Always acquire bill lock **first** — consistent order, no deadlock.

READ COMMITTED (default) + row lock is sufficient. SERIALIZABLE would need retry logic; not worth it. Say this in DECISIONS.

## 4.4 Reversal

```
BEGIN
  payment = SELECT p.* FROM payments p WHERE p.id=$1 AND p.org_id=$2 AND p.deleted_at IS NULL
  bill    = SELECT … FROM bills WHERE id=payment.bill_id AND org_id=$2 FOR UPDATE
  INSERT ledger_entries (…, payment_id, 'PAYMENT_REVERSED', +payment.amount)
  UPDATE payments SET deleted_at = now() WHERE id = payment.id
  balance = SUM(...)
  UPDATE bills SET status = (balance <= 0 ? 'PAID' : 'POSTED')
COMMIT
```

Original credit row untouched (B7). Ledger read for balance must **not** filter by payment soft-delete — entries are the truth, payments are just their origin. Worth a code comment; likely live-interview question.

## 4.5 LLM slice

**Chosen feature: bank/GCash line → suggested bill match, human confirms.**

- Endpoint: `POST /reconciliation/suggest` → body `{ rawLine: string }`
- Response: `{ parsed: {amount, reference, date}, candidates: [{billId, amountDue, balance, score}], suggestion: {billId, confidence, reasoning} | null, llmAvailable: bool, warning?: string }`

Why this one: a cashier staring at 200 unmatched bank lines is the actual daily pain in utility billing; ambiguous refs are where humans waste hours; and it's the direction where "suggest, don't act" is most obviously the right product call.

Guardrails (each maps to a stated grading criterion):

| Guardrail | Implementation |
|---|---|
| Doesn't corrupt money path | Separate module, separate endpoint, **zero writes to `payments`/`ledger_entries`** — asserted in a test |
| Amount parsing not trusted to model | Regex/deterministic parse in code; model receives already-parsed amount and a pre-filtered candidate list |
| Behind an interface | `LlmClient { complete(prompt, opts): Promise<string> }`; `StubLlmClient` default binding, `AnthropicLlmClient` behind `LLM_PROVIDER=anthropic` |
| Handles failure/latency | `AbortController` + 3s timeout; catch-all → deterministic candidates, `llmAvailable: false`. Never throws 5xx |
| Output validated | Model must return JSON; validate with `class-validator`/zod; **`billId` must be in the shortlist** or suggestion dropped |
| Human in control | No side effects. Cashier reads suggestion, then calls `POST /payments` themselves with the `externalRef` |
| No committed keys | `ANTHROPIC_API_KEY` via env, `.env.example` only, `.env` in `.gitignore` |

Shortlist is deterministic SQL: same org, status POSTED, `abs(balance − parsedAmount) < threshold` OR reference substring match, limit 5. Model ranks and writes the human-readable *why*. If the model is down, cashier still gets a usable shortlist — graceful degradation, not feature-off.

One working path = stub client returning a canned-but-real JSON response, exercised in tests.

## 4.6 Libraries

Keep to: `@nestjs/*`, `typeorm`, `pg`, `class-validator`, `class-transformer`, `jest`, `supertest`, `ts-jest`. Optional: `@nestjs/swagger` (cheap demo win), `@anthropic-ai/sdk` (real LLM path). Nothing else.

## 4.7 Security / performance / logging

- **Security:** no auth by design (stated), but validate `X-Org-Id` strictly; parameterized SQL only; global exception filter must not echo DB errors to clients; error bodies identical for "missing" and "other tenant's".
- **Performance:** indexes below; `SUM` over a bill's ledger is bounded. Note in DECISIONS that a denormalized `bills.balance` cache updated in the same transaction is the scale answer — deliberately deferred since derived-from-ledger is more provably correct.
- **Logging:** Nest logger, include `orgId` + `externalRef` (not amounts) on money mutations. One log line per completed transaction.

## 4.8 Architecture / Components

```
src/
  main.ts                       ValidationPipe, exception filter, port
  app.module.ts
  common/
    tenant/tenant.middleware.ts       parse+validate X-Org-Id
    tenant/org-id.decorator.ts        @OrgId()
    tenant/tenant-scope.service.ts    findBillOrThrow / findPaymentOrThrow → 404
    money/money.ts                    bigint-minor-units helper + validators
    money/is-money-string.validator.ts
    filters/all-exceptions.filter.ts
  database/
    data-source.ts                    CLI + app config, synchronize:false
    migrations/*.ts
  organizations/organization.entity.ts
  bills/     bill.entity.ts  bills.service.ts  bills.controller.ts  dto/
  payments/  payment.entity.ts payments.service.ts payments.controller.ts dto/
  ledger/    ledger-entry.entity.ts  ledger.service.ts   (append + balance only)
  llm/       llm-client.interface.ts stub-llm.client.ts anthropic-llm.client.ts llm.module.ts
  reconciliation/ reconciliation.service.ts reconciliation.controller.ts dto/
test/
  helpers/app.ts  helpers/db.ts  helpers/fixtures.ts
  tenant-isolation.e2e-spec.ts
  idempotency.e2e-spec.ts
  ledger-lifecycle.e2e-spec.ts
  concurrency.e2e-spec.ts
  reconciliation.e2e-spec.ts
```

Dependency direction: controllers → services → (`LedgerService`, `TenantScope`, `EntityManager`). `LedgerService` is the only writer of `ledger_entries` — single place to audit append-only-ness. `ReconciliationService` depends on read-only queries + `LlmClient`, and on nothing that writes.
