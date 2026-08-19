# Implementation Overview & Business Context

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers sections 1, 2.

[← Critical Review of the Prior Analysis](./00-critical-review.md) · [Index](./README.md) · [Technical Approach →](./02-technical-approach.md)

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

---

[← Critical Review of the Prior Analysis](./00-critical-review.md) · [Index](./README.md) · [Technical Approach →](./02-technical-approach.md)
