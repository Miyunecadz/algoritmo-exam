# Testing Plan

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers section 12.

[← Developer Task Breakdown](./07-task-breakdown.md) · [Index](./README.md) · [Error Handling & Security →](./09-errors-and-security.md)

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
| Double reverse | `DELETE` the same payment twice | 404 the second time, **not 500** ([C1](./00-critical-review.md)) |
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

---

[← Developer Task Breakdown](./07-task-breakdown.md) · [Index](./README.md) · [Error Handling & Security →](./09-errors-and-security.md)
