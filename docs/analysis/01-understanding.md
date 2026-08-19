# 1. Executive Summary & Understanding

> Part 1 of the [Mini Billing Ledger analysis](./README.md).

## 1. Executive Summary

Build thin multi-tenant billing REST API on NestJS + TypeORM + Postgres. Five endpoints. Real deliverable = five invariants (tenant isolation, exact money, idempotent ingestion, self-reconciling ledger, soft-delete) proven by runnable tests. Plus one thin LLM feature that **suggests, never writes money**.

Grading weight, my read: ~55% correctness of invariants, ~25% tests, ~10% LLM judgment, ~10% docs/commits. Endpoint surface itself is trivial — do not spend time there.

Core engineering bets:

- **Signed ledger amounts** so `SUM(amount)` *is* the balance. Ledger "nets out" becomes literal, provable in one query.
- **DB-enforced idempotency**: unique index on `(org_id, external_ref)` + catch `23505`, not read-then-write.
- **Row lock on bill** (`SELECT … FOR UPDATE`) inside every money transaction. Serializes status flips.
- **Composite FK** `payments(org_id, bill_id) → bills(org_id, id)`. Tenant integrity in schema, not just code.
- **LLM slice = bank-line match suggester.** Read-only, deterministic shortlist in SQL, model only ranks/explains, stub by default.

Budget: 4–6h. Roughly 1h scaffold+schema, 2h services/transactions, 1.5h tests, 45m LLM slice, 30m docs.

## 2. Understanding of the Assignment

### Problem

Utility billing shares one DB across many organizations. Money movement must be auditable and never lost. Two failure classes kill this kind of system in production: **cross-tenant leakage** and **double-credited payments from processor webhook retries**. Assignment is a controlled test of whether candidate defends against both, and whether ledger stays consistent under reversal.

### Objective

Small, correct, well-tested slice. Explicitly *not* breadth.

### Actors

| Actor | Interacts how |
|---|---|
| Upstream auth layer | Sets `X-Org-Id`. Assumed trustworthy. Not built. |
| Payment processor / webhook | Calls `POST /payments`, retries at-least-once. Source of idempotency pressure. |
| Cashier / billing admin | Posts bills, records payments, reverses mistakes, uses LLM match suggestion. |
| Payer | Indirect. Benefits from correct balance. |
| Interviewer | Reads DECISIONS.md, extends code live. Real audience — code must be explainable. |

### Explicit requirements

4 entities, 5 endpoints, 5 non-negotiables, 4 test scenarios (3 required + 1 bonus), 1 LLM feature, TypeORM migrations, README, DECISIONS.md ≤1 page, conventional commits.

### Assumptions I must label

1. **`X-Org-Id` trusted, no signature check.** Stated by assignment.
2. **Org rows seeded by fixture/migration**, no `POST /organizations` endpoint. Not asked for.
3. **`externalRef` unique per org**, not globally. Two orgs may legitimately get same processor ref from different processor accounts. Scoping to org is safer and matches tenant model.
4. **Replay after reversal returns the reversed payment, does not re-credit.** Unique index unconditional (not partial on `deleted_at IS NULL`). Rationale: processor ref identifies a real-world event exactly once; re-crediting on replay-after-refund is the exact bug idempotency exists to stop.
5. **Overpayment allowed**, bill goes PAID, balance goes negative (credit). Happens constantly in real billing.
6. **Payment allowed only on POSTED bill.** DRAFT/PAID/VOID reject with 409.
7. **Currency single/implicit.** No currency column. Out of scope, mention in DECISIONS.
8. **`amountDue` immutable after POSTED.** No bill-edit endpoint asked for.

### Ambiguous / missing / conflicting

| # | Gap | Resolution |
|---|---|---|
| A1 | "Soft-delete, never hard delete" applies to what? Ledger entries too? | `deletedAt` column on all entities; **ledger entries never deleted at all** — reversal is a new row. Soft-delete only actually exercised on Payment. |
| A2 | Ledger entry amount sign — magnitude+type, or signed? | Signed, with CHECK constraint tying sign to type. |
| A3 | Replay response code | 201 on create, **200 on replay**, identical body. Documented. |
| A4 | `DELETE /payments/:id` on already-reversed payment | 404 (soft-deleted rows invisible to tenant). Consistent with isolation rule. |
| A5 | VOID transition — no endpoint listed but status exists | Implement `POST /bills/:id/void` (DRAFT→VOID, POSTED→VOID only if zero payments). Cheap, completes state machine. |
| A6 | Reversal of partial payment on PAID bill | Recompute from ledger, not from flags. PAID→POSTED if balance > 0. |
| A7 | "Concurrent identical ingests" — same org or cross-org? | Same org. Cross-org same ref must produce two independent payments. |
| A8 | Balance definition when overpaid | Negative balance = credit. Status stays PAID. |
| A9 | Missing/malformed `X-Org-Id` | 400 (bad request, not 404 — no record was addressed). Non-existent-but-valid org UUID → 404 on any resource lookup. |

**Conflict worth naming:** assignment says 404-not-403 to avoid leaking existence, but nothing there conflicts with money-as-strings or reconciliation. Real tension is A4 vs. auditability: a cashier who reversed a payment can no longer see it via API. Note in DECISIONS that an admin/audit read path with `withDeleted` is the follow-up.
