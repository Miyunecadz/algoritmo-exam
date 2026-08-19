# 2. Requirements

> Part 2 of the [Mini Billing Ledger analysis](./README.md).

## Functional Requirements

| ID | Requirement | Priority | Why |
|---|---|---|---|
| F1 | `POST /bills` → DRAFT bill, org from header | Must | Entry point of money lifecycle |
| F2 | `POST /bills/:id/post` → DRAFT→POSTED + one `BILL_POSTED` entry, atomic | Must | Ledger debit must not exist without POSTED status, nor vice versa |
| F3 | `POST /payments` idempotent on `externalRef` → Payment + `PAYMENT_RECEIVED` entry + status recompute, atomic | Must | Core of exercise |
| F4 | `DELETE /payments/:id` → soft-delete payment + `PAYMENT_REVERSED` entry + reopen bill, atomic | Must | Reversal is where naive ledgers break |
| F5 | `GET /bills/:id` → bill + current balance | Must | Proves balance derivation |
| F6 | `POST /bills/:id/void` | Should | Completes documented state machine |
| F7 | LLM match-suggestion endpoint, read-only | Must (assignment) | Product-judgment signal |
| F8 | Health endpoint | Nice | Trivial, aids README verification |

## Non-Functional Requirements

| ID | Requirement | Priority | Why |
|---|---|---|---|
| N1 | `numeric(12,2)` in DB, `string` in TS and JSON | Must | Float rounds; JS `number` loses cents at scale. Non-negotiable #2 |
| N2 | Every tenant-scoped query filtered by `org_id` | Must | Non-negotiable #1 |
| N3 | All multi-row money writes in one transaction | Must | Non-negotiable #4 |
| N4 | Correct under concurrency (same ref, same bill) | Must | Bonus test + real webhook behaviour |
| N5 | TypeORM migrations, `synchronize: false` | Must | Explicitly required |
| N6 | No secrets committed; `.env.example` only | Must | LLM grading criterion |
| N7 | LLM call cannot block/corrupt money path; timeout + fallback | Must | LLM grading criterion |
| N8 | One-command Postgres, migrate, test | Must | Deliverable |
| N9 | Conventional commits, readable history | Must | Deliverable |
| N10 | Strict TS, lint clean | Should | Code-quality signal |
| N11 | Structured logging with orgId, no cross-tenant amount leakage in logs | Should | Production habit signal |

## Business Rules

| ID | Rule |
|---|---|
| B1 | Bill lifecycle: `DRAFT → POSTED → PAID`; `DRAFT → VOID`; `POSTED → VOID` (only if no payments); `PAID → POSTED` on reversal. Any other transition = 409 |
| B2 | Ledger sign convention: `BILL_POSTED = +amountDue`, `PAYMENT_RECEIVED = −amount`, `PAYMENT_REVERSED = +amount` |
| B3 | `balance(bill) = SUM(ledger_entries.amount WHERE bill_id = :id AND org_id = :org)` |
| B4 | DRAFT bill has zero ledger entries, balance `0.00` |
| B5 | Bill is PAID iff `balance <= 0` and status was POSTED |
| B6 | One `externalRef` per org = at most one Payment and at most one `PAYMENT_RECEIVED` entry, forever |
| B7 | Reversal never mutates or deletes the original `PAYMENT_RECEIVED` entry |
| B8 | Payment accepted only when bill status = POSTED |
| B9 | Payment and bill must share `org_id` — enforced by composite FK |
| B10 | Ledger entries are append-only. No update, no delete |
| B11 | Cross-org access to any resource = 404, never 403, never 200 |
| B12 | LLM path never inserts Payment or LedgerEntry |

## Validation & Error Handling

| Input | Rule | Failure |
|---|---|---|
| `X-Org-Id` | present, UUID | 400 `MISSING_ORG_CONTEXT` / `INVALID_ORG_CONTEXT` |
| `amountDue`, `amount` | string matching `/^\d{1,10}(\.\d{1,2})?$/`, `> 0`, ≤ `9999999999.99` | 400 |
| `amount` sent as JSON number | reject | 400 — explicit, prevents float ingress |
| `externalRef` | non-empty string, ≤ 128 chars, trimmed | 400 |
| `billId` | UUID | 400 (malformed) / 404 (not found or other org) |
| Bad state transition | see B1 | 409 `INVALID_BILL_STATE` |
| Payment on non-POSTED bill | B8 | 409 |
| Unique violation on `external_ref` | concurrent replay | not an error — resolve to 200 + existing payment |
| DB unavailable | — | 503, no partial writes |
| LLM timeout / bad JSON / provider error | N7 | 200 with deterministic candidates + `llmAvailable: false`, `warning` field |

Use `class-validator` + global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`. Global exception filter for consistent `{ statusCode, code, message }` shape. **Do not** use `@Transform` to coerce money to number.

## Edge Cases

1. Post a DRAFT bill twice → second is 409, still exactly one `BILL_POSTED` entry.
2. Two concurrent `POST /bills/:id/post` → one wins. Guard with `FOR UPDATE` + status re-check inside lock, **and** unique partial index `(bill_id) WHERE type='BILL_POSTED'`. Do both.
3. Two concurrent identical `POST /payments` → one payment, one entry, one 201 + one 200.
4. Two concurrent *different* payments on same bill, together exceeding due → both recorded, bill PAID once, `FOR UPDATE` prevents lost status update.
5. Partial pay → balance decreases, status stays POSTED.
6. Exact pay → balance `0.00`, PAID.
7. Overpay → negative balance, PAID.
8. Reverse the only payment → balance back to full `amountDue`, status POSTED, three ledger rows netting to `+amountDue`.
9. Reverse one of two payments → balance = due − remaining, status POSTED.
10. Reverse then replay same `externalRef` → 200, no new credit, balance unchanged. *(Sharpest case; test it.)*
11. Same `externalRef` in two different orgs → two payments, both valid.
12. `DELETE` a payment belonging to another org → 404, zero ledger rows written.
13. `DELETE` already-reversed payment → 404.
14. Payment on VOID bill → 409.
15. `GET` a DRAFT bill → balance `"0.00"`, not `null`, not `"0"`.
16. Non-existent-but-well-formed org UUID → 404 on everything.
17. Serialization: `"100.00"` not `"100"`, not `100`. Assert exact strings in tests.
