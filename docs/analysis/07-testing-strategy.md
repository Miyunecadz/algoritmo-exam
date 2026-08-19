# 7. Testing Strategy

> Part 7 of the [Mini Billing Ledger analysis](./README.md).

Integration/e2e over real Postgres is the right level here — every invariant lives in transactions, constraints, and locks that unit tests with mocked repositories cannot prove. Keep unit tests only for `Money` and the LLM response validator.

**Harness:** `jest` + `supertest`, `globalSetup` runs migrations against `billing_test`, `beforeEach` truncates all tables + reseeds two orgs (`TRUNCATE … RESTART IDENTITY CASCADE`). One shared Nest app instance per spec file. Pool size ≥ 5 so concurrency tests are genuinely concurrent.

## Required scenario 1 — tenant isolation

```
seed: orgA bill B (POSTED, 100.00), orgB
GET    /bills/B  as orgB                    → 404
POST   /payments {billId:B,...} as orgB     → 404
DELETE /payments/{orgA payment} as orgB     → 404
assert: SELECT count(*) FROM ledger_entries  unchanged from before
assert: SELECT count(*) FROM payments        unchanged
assert: no response body contains B's amountDue
```

Snapshot counts before/after — the "zero ledger rows" clause is the actual assertion, not the 404.

## Required scenario 2 — idempotency

```
POST /payments {ref:"REF-1", amount:"40.00"}  → 201, payment P
POST /payments {ref:"REF-1", amount:"40.00"}  → 200, id === P.id
payments where external_ref='REF-1'           → 1
ledger_entries where type='PAYMENT_RECEIVED'  → 1
GET /bills/B .balance                         → "60.00"
```

Plus: same ref with a *different* amount → still 200 + original payment, no new credit (mismatched replay must not silently create).
Plus: same ref under orgB → 201, separate payment.

## Required scenario 3 — lifecycle

```
create   amountDue "100.00"  → DRAFT, balance "0.00"
post                          → POSTED, balance "100.00", 1 entry
pay "40.00"                   → POSTED, balance "60.00"
pay "60.00"                   → PAID,   balance "0.00"
reverse the "60.00" payment   → POSTED, balance "60.00"
assert SUM(amount) = 60.00 and 4 ledger rows, types in order
assert original PAYMENT_RECEIVED row unchanged (updated_at/amount identical)
assert every money field is a string with exactly 2 decimals
```

## Bonus scenario 4 — concurrency

```
const [a,b] = await Promise.all([post(ref), post(ref)])
statuses.sort() === [200, 201]
payments count === 1
PAYMENT_RECEIVED count === 1
balance === "60.00"
```

Repeat in a `for (let i=0;i<5;i++)` loop over fresh refs to shake out flakiness.

Second concurrency case: two *different* refs, `"60.00"` + `"40.00"`, on a `100.00` bill → both 201, status PAID exactly once, balance `"0.00"` — proves the `FOR UPDATE` lock, not just the unique index.

## Additional cases

- Post twice → 409, one `BILL_POSTED` entry
- Payment on DRAFT → 409, zero payments
- Payment on VOID → 409
- Overpay `"150.00"` on `100.00` → PAID, balance `"-50.00"`
- Reverse → replay same ref → 200, balance unchanged (**the sharp one**)
- `amount: 40.5` as JSON number → 400
- `amount: "40.555"` → 400
- Missing `X-Org-Id` → 400; malformed → 400
- LLM: stub returns valid suggestion → 200; stub throws → 200 + `llmAvailable:false`; stub returns a `billId` outside shortlist → suggestion dropped; **after any suggest call, payments + ledger counts unchanged**

## Regression guard worth 5 minutes

A single test asserting no service throws `ForbiddenException` — encodes non-negotiable #1's "404 not 403" as a test, not a convention.
