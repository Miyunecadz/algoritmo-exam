# Mini Billing Ledger — Technical Implementation Plan

Execution plan for the NestJS + TypeORM + Postgres multi-tenant billing take-home. Derived from [`docs/analysis/`](../analysis/README.md) and verified against the original brief at [`docs/assignment.md`](../assignment.md).

Serves two readers: a **developer** who needs to know exactly what to change and how to verify it, and a **Project Owner** who needs to understand what is being built and why.

## Documents

| # | File | Contents |
|---|---|---|
| 0 | [00-critical-review.md](./00-critical-review.md) | **Read first.** 8 corrections to defects in the prior analysis, 4 trims, 3 reinforcements |
| 1 | [01-overview-and-context.md](./01-overview-and-context.md) | What is being built, why, and the business problem in plain language |
| 2 | [02-technical-approach.md](./02-technical-approach.md) | Architecture, and every significant decision with reason / alternative / why-not |
| 3 | [03-scope-and-traceability.md](./03-scope-and-traceability.md) | In scope, out of scope, future work, and the requirement → implementation → verification map |
| 4 | [04-codebase-and-data-model.md](./04-codebase-and-data-model.md) | Files to create, conventions, full schema with constraints and indexes |
| 5 | [05-api-and-flows.md](./05-api-and-flows.md) | Every endpoint contract, request/response shapes, transaction scripts, user flow |
| 6 | [06-implementation-steps.md](./06-implementation-steps.md) | **The core.** 10 sequential steps with objective / changes / reason / result / verification / commit |
| 7 | [07-task-breakdown.md](./07-task-breakdown.md) | 17 developer tasks with dependencies and acceptance criteria |
| 8 | [08-testing-plan.md](./08-testing-plan.md) | Test level and why, the 4 required scenarios, edge cases, regression guard |
| 9 | [09-errors-and-security.md](./09-errors-and-security.md) | Failure scenarios with codes and recovery; tenant authorisation and secrets |
| 10 | [10-performance-and-deployment.md](./10-performance-and-deployment.md) | Performance posture, migrations, environment variables, rollback |
| 11 | [11-risks-and-done.md](./11-risks-and-done.md) | Risk table with mitigations; the full Definition of Done |
| 12 | [12-project-owner-summary.md](./12-project-owner-summary.md) | Non-technical summary — no code knowledge required |
| 13 | [13-quick-start-and-checklist.md](./13-quick-start-and-checklist.md) | Build sequence, files to add, commands, final working checklist |

## Reading paths

**Developer, starting the build:** [0](./00-critical-review.md) → [2](./02-technical-approach.md) → [6](./06-implementation-steps.md), with [4](./04-codebase-and-data-model.md) and [5](./05-api-and-flows.md) open alongside. Keep [13](./13-quick-start-and-checklist.md) as the working checklist.

**Project Owner / reviewer:** [12](./12-project-owner-summary.md) first, then [1](./01-overview-and-context.md) and [3](./03-scope-and-traceability.md) for scope, [11](./11-risks-and-done.md) for risk.

**Reviewing the approach before approving:** [0](./00-critical-review.md) and [2](./02-technical-approach.md) carry all the reasoning.

## What this plan changes from the analysis

The analysis was not copied forward. Two of its transaction scripts contain real concurrency defects, corrected in [00-critical-review.md](./00-critical-review.md):

- **C1** — reversal reads the payment *before* acquiring the bill lock, so two concurrent reversals both pass the `deleted_at IS NULL` check and collide on a unique index as a 500 instead of a clean 404.
- **C5** — a bare `23505` catch treats a ledger constraint violation as an idempotent replay, turning a genuine invariant breach into a 200.

Six further corrections cover a soft-delete column that would silently break balance reads, an undefined response field, an invalid shortlist query, and replay-with-mismatched-amount semantics.

## The five bets, unchanged

1. **Signed ledger amounts** — `balance = SUM(amount)`, reconciliation provable in one query.
2. **DB-enforced idempotency** — `UNIQUE (org_id, external_ref)`, insert-first, discriminate on the constraint name.
3. **`SELECT … FOR UPDATE` on the bill first** in every money transaction.
4. **Composite FK** `payments(org_id, bill_id) → bills(org_id, id)` — tenant integrity in the schema.
5. **The LLM slice is read-only** — a bank-line match suggester that suggests and never writes.

## Conventions in this plan

- Section numbers (`§0`–`§21`) are stable across the split and are used for cross-references throughout; each links to the file that contains it.
- Correction, trim, and reinforcement labels (`C1`–`C8`, `T1`–`T4`, `R1`–`R3`) all resolve to [00-critical-review.md](./00-critical-review.md).
- Anything unverified is marked `TO VERIFY` rather than invented.
