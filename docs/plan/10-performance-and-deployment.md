# Performance & Deployment

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers sections 15, 16.

[← Error Handling & Security](./09-errors-and-security.md) · [Index](./README.md) · [Risks & Definition of Done →](./11-risks-and-done.md)

---

## 15. Performance & Scalability Considerations

**No special performance work is required for this assignment, and none should be done.** The dataset is a handful of test rows and the graded property is correctness. Premature optimisation here would actively cost points by obscuring the logic.

That said, the design already avoids the traps that would matter, and being able to name them is worth more than optimising them:

| Concern | Status |
|---|---|
| **N+1 in the AI shortlist** | Avoided by design — one query with `LEFT JOIN LATERAL` computes each candidate's balance ([C6](./00-critical-review.md)). This is the only place in the build where a naive implementation would produce N+1 |
| **Balance recomputation** | `SUM` over one bill's ledger entries, served by `INDEX (org_id, bill_id, created_at)`. Bounded by payments-per-bill, which is small in this domain |
| **`balance` and `amountPaid` in one round trip** | A single query with `FILTER (WHERE …)` rather than two queries ([§8.6](./05-api-and-flows.md)) |
| **Status recompute** | A single `UPDATE … CASE WHEN (SELECT SUM …)`. One statement, no read-then-write round trip, and no balance value in TypeScript ([R2](./00-critical-review.md)) |
| **Lock contention** | `FOR UPDATE` on the bill serializes concurrent payments *for that bill only*. Different bills never contend. Correct trade: contention is per-bill and bills are the natural unit of serialization |
| **Transaction scope** | Every transaction is a handful of statements against a single bill's rows. No long-running transactions, no user input awaited inside a transaction |
| **Connection pool** | `max: 10`. Below 5 the concurrency spec silently serializes and stops proving anything |
| **AI latency** | Bounded by a 3s `AbortController`, on a separate endpoint. The money path never waits on a model |
| **Pagination** | Not applicable — there are no list endpoints in scope |

**Where this design stops scaling, and the answer** (DECISIONS.md, not code): once a bill accumulates thousands of ledger entries, recomputing `SUM` on every read becomes the bottleneck. The answer is a denormalized `bills.balance` column updated **inside the same transaction** as the ledger append, with the ledger remaining the source of truth and a periodic reconciliation job asserting the two agree. It is deliberately deferred because derived-from-ledger is more provably correct, and provable correctness is what this exercise is measuring.

---

## 16. Migration / Deployment Considerations

**Database migrations.** Two, both hand-written, both run by `npm run migration:run`:

1. `Init` — all four tables with every constraint and index.
2. `SeedOrgs` — two organizations with fixed UUIDs.

`synchronize: false` throughout. TypeORM must never alter the schema at boot; the migrations are the only source of schema truth.

**Environment variables.**

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Application database | — (required) |
| `TEST_DATABASE_URL` | e2e database — **must be a different database**, since the harness truncates every table | — (required for tests) |
| `PORT` | HTTP port | `3000` |
| `LLM_PROVIDER` | `stub` or `anthropic` | `stub` |
| `ANTHROPIC_API_KEY` | Only when `LLM_PROVIDER=anthropic` | empty |
| `LLM_TIMEOUT_MS` | Abort threshold | `3000` |

`.env.example` is committed with every key and no values. `.env` is gitignored from the first commit.

**Deployment sequencing.** Not applicable — there is no running system and no existing data. For completeness, the order a reviewer will follow is: start Postgres → create both databases → run migrations → start the application or the suite.

**Feature flags.** One, effectively: `LLM_PROVIDER`. It defaults to `stub`, so the application runs fully with no API key. That is deliberate — the reviewer must be able to run everything without obtaining credentials.

**Backward compatibility.** Not applicable. Greenfield.

**Rollback.** Every migration has a working `down()`. `npm run migration:revert` reverses the last one. Rarely needed here, but a migration without a tested `down()` is incomplete work.

**The one deployment risk that actually applies:** a migration chain that works against the incrementally-built local database but fails against a fresh one. **Mitigation is mandatory, not optional** — as the first action of Step 10, drop the database entirely, run the full chain, and run the full suite. This is the most common cause of a submission that does not start on the reviewer's machine.

**Confirmed from the brief** (`docs/assignment.md`): Postgres 15, started with the exact command quoted in [§20](./13-quick-start-and-checklist.md). No `pgcrypto` extension required.

**`TO VERIFY` before starting:**

- Node.js version and package manager (npm assumed throughout).
- How `billing_test` gets created — a `db:create-test` script, or a documented `psql` line in the README. Do not leave this implicit; a reviewer hitting a missing test database will stop there.
- The brief allows 24 hours from receipt for submission. Confirm the deadline before starting the 4–6 hour build.

---

---

[← Error Handling & Security](./09-errors-and-security.md) · [Index](./README.md) · [Risks & Definition of Done →](./11-risks-and-done.md)
