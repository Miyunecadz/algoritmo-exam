# API / Backend Changes & Client Flows

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers sections 8, 9.

[← Codebase Areas & Data Model](./04-codebase-and-data-model.md) · [Index](./README.md) · [Detailed Step-by-Step Implementation Plan →](./06-implementation-steps.md)

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
   No balance value crosses into TypeScript ([R2](./00-critical-review.md)). The `status IN` guard is [C7](./00-critical-review.md).
6. Commit ⇒ **201**.

**Behaviour on `23505`:**

- If `error.constraint !== 'payments_org_external_ref_uq'`, **rethrow.** Any other unique violation is a genuine invariant breach and must surface as a 500 ([C5](./00-critical-review.md)).
- Otherwise: the transaction is already aborted — Postgres refuses every subsequent statement in it, which is the most common way this pattern is implemented incorrectly. Let it roll back, then in a **brand-new transaction** re-read `payments` by `(org_id, external_ref)` with **`withDeleted: true`**, so a replay after a reversal resolves to the reversed payment instead of 404-ing.
- Compare the submitted `amount` with the stored one. If they differ, set `warning: 'AMOUNT_MISMATCH_ON_REPLAY'` ([C4](./00-critical-review.md)). Either way, **no new credit.**
- Respond **200** with `replayed: true`.

**Why the re-read always succeeds.** The `INSERT` blocks on the unique index until the competing transaction resolves. A `23505` therefore means that transaction committed, so the row is visible to a transaction started afterwards under READ COMMITTED.

**Errors.** 400, 404 (bill missing or another tenant's), 409 `INVALID_BILL_STATE`, 503 on database unavailability with no partial write.

### 8.5 `DELETE /payments/:id` — reversal (revised, [C1](./00-critical-review.md))

**Purpose.** Reverse a payment without destroying its record.

```jsonc
// 200
{ "payment": { "id": "…", "amount": "60.00", "reversedAt": "…" },
  "bill": { "id": "…", "status": "POSTED", "balance": "60.00",
            "amountPaid": "40.00", "amountDue": "100.00" } }
```

**Behaviour, in one transaction — note the corrected ordering:**

1. Resolve the payment's `bill_id` with an unlocked read scoped to `(id, org_id)`. Miss ⇒ 404.
2. **Lock the bill** `FOR UPDATE`. Always first among locks ([R1](./00-critical-review.md)).
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
- `amountPaid` ([C3](./00-critical-review.md) — previously undefined) = `-1 × SUM(amount) WHERE type IN ('PAYMENT_RECEIVED','PAYMENT_REVERSED')`, i.e. net cash currently applied. DRAFT ⇒ `"0.00"`. Computed in the **same** query as `balance` via `FILTER (WHERE …)`; do not issue a second round trip.
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
2. **Deterministic shortlist in SQL**, one query, no N+1 ([C6](./00-critical-review.md)):
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

---

[← Codebase Areas & Data Model](./04-codebase-and-data-model.md) · [Index](./README.md) · [Detailed Step-by-Step Implementation Plan →](./06-implementation-steps.md)
