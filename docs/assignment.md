# Take-Home: Mini Billing Ledger (Backend)

**Time:** ~4–6 focused hours. Please submit within **24 hours** of receiving this.
**Stack:** NestJS + TypeORM + PostgreSQL (TypeScript).
**AI tools:** Encouraged — use whatever you normally use. One rule: **you own the code.** We'll ask you to walk us through it and extend a piece live, so anything you can't explain or didn't direct will count against you, not for you.

---

## Scenario

A thin slice of a utility-billing system. Organizations issue bills, receive payments, and **every money movement is recorded in a ledger that must always reconcile.** Many organizations share one database — a tenant must never see or touch another tenant's data.

## What to build

A small REST API. Keep the model minimal:

- **Organization** — the tenant root.
- **Bill** — belongs to an org; has an `amountDue`; status `DRAFT → POSTED → PAID | VOID`.
- **Payment** — belongs to an org + a bill; has an `amount` and an `externalRef` (the payment processor's id).
- **LedgerEntry** — `BILL_POSTED` (debit), `PAYMENT_RECEIVED` (credit), `PAYMENT_REVERSED` (credit reversal); each carries org, bill, optional payment, and amount.

Endpoints (thin is fine):

1. `POST /bills` — create a DRAFT bill.
2. `POST /bills/:id/post` — DRAFT → POSTED; writes a `BILL_POSTED` ledger entry.
3. `POST /payments` — **idempotent on `externalRef`**; creates the payment + a `PAYMENT_RECEIVED` entry; flips the bill to PAID once it's covered.
4. `DELETE /payments/:id` — reverses the payment (`PAYMENT_REVERSED`) and re-opens the bill.
5. `GET /bills/:id` — the bill plus its current balance.

Tenant context arrives in a request header (e.g. `X-Org-Id`) — assume an upstream auth layer set it. You don't need to build real auth.

## Non-negotiables (this is the actual point of the exercise)

1. **Tenant isolation.** Every query is scoped to the caller's org. A cross-org access returns **404, not 403** — don't leak that the record exists.
2. **Money is exact.** Postgres `numeric(12,2)`, amounts serialized as **strings**. Never use `float` / JS `number` for money math.
3. **Idempotent ingestion.** The same `externalRef` posted twice yields **one** payment and **one** ledger entry — even if both requests arrive at the same instant.
4. **The ledger always reconciles.** After any sequence of post → pay → reverse, the bill's balance and status are correct and the ledger nets out.
5. **Soft-delete**, never hard delete.

## Tests (required — this is how we compare candidates)

Ship runnable tests that prove:

- a cross-org read **and** a cross-org payment attempt both return 404 **and create zero ledger rows**;
- replaying the same `externalRef` does not double-credit the bill;
- balance and status are correct across **post → partial pay → full pay → reverse**;
- _(bonus, high signal)_ two concurrent identical ingests still produce exactly one payment.

## The LLM slice (show us your product thinking)

Add **one** small, working feature where an LLM genuinely improves the billing/payments experience for a real user — a cashier, an admin, or the payer. **You choose it.** A few directions (don't feel limited): turn a messy bank / GCash CSV line into a matched bill; draft a friendly, accurate overdue reminder from the ledger; answer *"what does this account owe, and why?"* in plain language over the ledger; explain a payment discrepancy.

We're grading **judgment, not model wizardry**:
- Is it actually useful for someone doing billing work?
- Is the integration clean — behind an interface, doesn't block or corrupt the core money transaction, handles failure/latency, no API keys committed?
- Did you keep a **human in control** where money is involved (suggest, don't silently act)?

The LLM call itself may be **mocked/stubbed** — we care about the design and one working path, not that you burned tokens.

## Deliverables

- A git repo (private invite or a zip) with conventional commits.
- `README.md` — one command to start Postgres, one to migrate, one to run tests.
- `DECISIONS.md` (**≤ 1 page**): why numeric-not-float; how idempotency works; how tenant isolation is enforced and why 404; how a reversal keeps the ledger balanced; your LLM feature and its guardrails; and **one thing you'd do differently with more time.**
- Be ready for a **30-minute walkthrough** where we ask you to explain a choice and extend the code live.

## Setup hint

```bash
docker run --name tt-pg -e POSTGRES_PASSWORD=pg -p 5432:5432 -d postgres:15
```

Use TypeORM **migrations** (not `synchronize: true`).

---

*Scope note: the core (bills / payments / ledger + the five non-negotiables + the tests) is the bulk of the work. The LLM slice is meant to be thin. `DECISIONS.md` is short on purpose. We'd rather see a small, correct, well-tested, well-explained submission than a large half-working one.*
