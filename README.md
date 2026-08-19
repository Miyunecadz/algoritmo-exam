# Mini Billing Ledger

A thin slice of a multi-tenant utility-billing system: organizations issue bills, receive payments,
and every money movement is recorded in an append-only ledger that always reconciles.

NestJS · TypeORM · PostgreSQL · TypeScript (strict).

## Quick start

```bash
# 1. Postgres
npm run db:up && npm run db:create

# 2. Install and migrate
npm install && npm run migration:run

# 3. Tests
npm run test:e2e     # 42 integration tests against a real Postgres
npm test             # money / validator unit tests
```

`npm run db:up` starts `postgres:15` as the container `billing-pg`; `npm run db:create` creates the
`billing` and `billing_test` databases. Copy `.env.example` to `.env` if your Postgres differs from
the defaults. The e2e suite runs its own migrations against `billing_test` before the first spec, so
a freshly created database is all it needs.

Run the API with `npm run start:dev`, then `curl localhost:3000/health`.

## The five invariants

| Invariant | How it is enforced |
|---|---|
| **Tenant isolation** | Every lookup goes through `TenantScope`, whose only failure mode is `NotFoundException` — cross-tenant access is a 404 with a byte-identical body to "does not exist". Composite foreign keys `(org_id, bill_id)` and `(org_id, payment_id)` make a cross-tenant row physically unrepresentable. |
| **Exact money** | `numeric(12,2)` in Postgres, `string` in TypeScript and JSON. No `pg` numeric parser is registered, no `parseFloat` exists in the codebase, and every sum and comparison happens in SQL. `@IsMoneyString()` rejects JSON numbers at the boundary. |
| **Idempotent ingestion** | `UNIQUE (org_id, external_ref)`. The service inserts first and resolves the `23505` — never check-then-insert, which has a window two simultaneous webhooks can occupy. |
| **The ledger reconciles** | Signed amounts, so `balance = SUM(amount)`. Balance is derived, never stored. Reversal appends a compensating entry rather than mutating history. |
| **Soft delete** | `deleted_at` on organizations, bills and payments; reversal soft-deletes the payment. Ledger entries are never deleted at all. |

## Endpoints

All requests require an `X-Org-Id` header. All money fields are strings with exactly two decimals.
Errors are always `{ statusCode, code, message }`.

| Method | Path | Result |
|---|---|---|
| `POST` | `/bills` | 201 — creates a DRAFT bill |
| `POST` | `/bills/:id/post` | 200 — DRAFT → POSTED, writes the `BILL_POSTED` debit |
| `POST` | `/bills/:id/void` | 200 — DRAFT → VOID, or POSTED → VOID when the bill has no payments |
| `GET` | `/bills/:id` | 200 — the bill plus `balance` and `amountPaid` |
| `POST` | `/payments` | **201** when created, **200** when the `externalRef` was already recorded |
| `DELETE` | `/payments/:id` | 200 — reverses the payment and reopens the bill |
| `POST` | `/reconciliation/suggest` | 200 — AI-assisted bank-line match suggestion (read-only) |
| `GET` | `/health` | 200 — no tenant context required |

## Walkthrough

Two organizations are seeded by migration:

```bash
ORG_A=11111111-1111-1111-1111-111111111111   # Acme Water District
ORG_B=22222222-2222-2222-2222-222222222222   # Northside Power Co-op
```

```bash
# Create and post a 100.00 bill
BILL=$(curl -s -XPOST localhost:3000/bills -H "X-Org-Id: $ORG_A" \
  -H 'content-type: application/json' -d '{"amountDue":"100.00"}' | jq -r .id)
curl -s -XPOST localhost:3000/bills/$BILL/post -H "X-Org-Id: $ORG_A"
# → status POSTED, balance "100.00"

# Partial payment
curl -s -XPOST localhost:3000/payments -H "X-Org-Id: $ORG_A" -H 'content-type: application/json' \
  -d "{\"billId\":\"$BILL\",\"amount\":\"40.00\",\"externalRef\":\"REF-1\"}"
# → 201, balance "60.00"

# The processor retries the same webhook
curl -s -XPOST localhost:3000/payments -H "X-Org-Id: $ORG_A" -H 'content-type: application/json' \
  -d "{\"billId\":\"$BILL\",\"amount\":\"40.00\",\"externalRef\":\"REF-1\"}"
# → 200, "replayed": true, balance still "60.00" — one payment, one ledger entry

# Pay the rest, then reverse it
PAY=$(curl -s -XPOST localhost:3000/payments -H "X-Org-Id: $ORG_A" -H 'content-type: application/json' \
  -d "{\"billId\":\"$BILL\",\"amount\":\"60.00\",\"externalRef\":\"REF-2\"}" | jq -r .payment.id)
# → status PAID, balance "0.00"
curl -s -XDELETE localhost:3000/payments/$PAY -H "X-Org-Id: $ORG_A"
# → status POSTED, balance "60.00", four ledger rows, none removed

# Another tenant sees nothing
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/bills/$BILL -H "X-Org-Id: $ORG_B"   # 404

# AI-assisted matching — suggests, never acts
curl -s -XPOST localhost:3000/reconciliation/suggest -H "X-Org-Id: $ORG_A" \
  -H 'content-type: application/json' \
  -d '{"rawLine":"GCASH TRANSFER PHP 60.00 REF 8891 2026-08-14"}'
```

## The AI slice

`POST /reconciliation/suggest` takes one raw bank / GCash statement line and helps a cashier decide
which bill it belongs to. The amount is parsed by a regex **in code**, the candidate bills are
shortlisted by **one SQL query** scoped to the caller's organization, and the model only ranks that
shortlist and writes the human-readable explanation. Its answer is discarded unless the bill it
names is one we supplied. If the provider is slow or down, the cashier still gets the ranked
shortlist and the endpoint still returns 200.

Nothing here writes: the cashier reads the suggestion and then calls `POST /payments` themselves.
That is the only step that moves money.

The default provider is `StubLlmClient` — the repo runs, including its full test suite, with no API
key and no network access. Set `LLM_PROVIDER=anthropic` plus `ANTHROPIC_API_KEY` in `.env` to use
the real client.

## Assumptions

- **`X-Org-Id` is trusted**, as the assignment states — an upstream authenticated gateway is assumed
  to set it. In production this header must be derived from a verified credential; the middleware is
  where that verification would live.
- **Organizations are seeded by migration.** No org CRUD endpoints were asked for, so none exist.
- **A single, implicit currency.** No currency column.
- **`amountDue` is immutable once the bill is posted.**
- **Reversals are all-or-nothing** — a payment reverses in full.
- **Overpayment is allowed**: the bill becomes PAID and the balance goes negative (a credit).

See [DECISIONS.md](./DECISIONS.md) for the reasoning behind the design.

## Scripts

| Script | Purpose |
|---|---|
| `npm run db:up` / `db:create` | Start Postgres in Docker and create both databases |
| `npm run migration:run` / `migration:revert` | Apply / roll back migrations (`synchronize` is always false) |
| `npm run test:e2e` | Integration suite against a real Postgres |
| `npm test` | Unit tests for the money primitives and the validator |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` and ESLint |
