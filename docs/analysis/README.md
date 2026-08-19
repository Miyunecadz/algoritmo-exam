# Mini Billing Ledger — Assignment Analysis

Planning docs for the NestJS + TypeORM + Postgres multi-tenant billing take-home. Analysis only — no implementation.

## Documents

| # | File | Contents |
|---|---|---|
| 1 | [01-understanding.md](./01-understanding.md) | Executive summary, problem, actors, explicit requirements vs. assumptions, ambiguity table |
| 2 | [02-requirements.md](./02-requirements.md) | Functional / non-functional requirements, business rules, validation, edge cases |
| 3 | [03-scope.md](./03-scope.md) | In scope, out of scope, do-not-over-engineer, priorities, greenfield conventions |
| 4 | [04-technical-approach.md](./04-technical-approach.md) | Money, tenant isolation, idempotency, reversal, LLM slice, libraries, architecture |
| 5 | [05-data-and-api.md](./05-data-and-api.md) | Full schema with constraints/indexes, endpoint table |
| 6 | [06-implementation-plan.md](./06-implementation-plan.md) | 10 steps with why / files / prereqs / result / commit message |
| 7 | [07-testing-strategy.md](./07-testing-strategy.md) | Harness, 4 required scenarios, extra cases, regression guard |
| 8 | [08-risks.md](./08-risks.md) | Risk table with mitigations |
| 9 | [09-definition-of-done.md](./09-definition-of-done.md) | Submission checklist |
| 10 | [10-execution-order.md](./10-execution-order.md) | Phased order, open questions, final recommendation |

## The five bets

1. **Signed ledger amounts** — `balance = SUM(amount)`. Reconciliation provable in one query.
2. **DB-enforced idempotency** — `UNIQUE (org_id, external_ref)`, insert-first, catch `23505`.
3. **`SELECT … FOR UPDATE` on the bill** in every money transaction — serializes status flips.
4. **Composite FK** `payments(org_id, bill_id) → bills(org_id, id)` — tenant integrity in the schema.
5. **LLM slice is read-only** — bank-line match suggester, stub by default, zero money writes.

## Time budget (4–6h)

| Block | Time |
|---|---|
| Scaffold + schema/migrations | ~1h15m |
| Money helper + tenant scope | ~50m |
| Bills / payments / reversal services | ~2h |
| Test suite | ~1h30m |
| LLM slice | ~45m |
| Docs + polish | ~30m |

Start at [01-understanding.md](./01-understanding.md), then read [04](./04-technical-approach.md) and [06](./06-implementation-plan.md) before writing code.
