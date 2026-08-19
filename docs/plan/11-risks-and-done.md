# Risks & Definition of Done

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers sections 17, 18.

[← Performance & Deployment](./10-performance-and-deployment.md) · [Index](./README.md) · [Project Owner Summary →](./12-project-owner-summary.md)

---

## 17. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| `numeric` silently parsed into a JS number | Critical — fails N1, silent cents loss | Low | Never register a pg numeric parser; comment saying so; assert `typeof === 'string'` in the specs |
| TypeORM's in-memory entity returns a `numeric` field in an unexpected shape after `save()` | High — wrong response body | Medium | Map every response through an explicit DTO; re-read after write where there is any doubt |
| A forgotten `org_id` filter in one query | Critical — fails the headline requirement | Medium | Route every lookup through `TenantScope`; composite FKs as the backstop; the isolation spec |
| Check-then-insert idempotency | Critical — double credit under race | Medium | Insert-first + constraint-name-discriminated `23505` handling |
| Catching `23505` and continuing **inside** the same transaction | High — every later statement errors; misleading failure | **High** — this is the single most common implementation error in this pattern | Roll back, re-read in a **new** transaction; call it out in a code comment |
| Catching `23505` too broadly | High — a real invariant breach returns 200 | Medium | Discriminate on `error.constraint` ([C5](./00-critical-review.md)) |
| Missing `FOR UPDATE` | High — lost status update when two payments land together | Medium | Lock the bill first in every money transaction; concurrency Case B proves it |
| Reversal race producing a 500 instead of a 404 | Medium | Medium | Re-select the payment `FOR UPDATE` inside the bill lock ([C1](./00-critical-review.md)) |
| Deadlock from inconsistent lock order | Medium | Low | Always lock the bill before touching payments or ledger rows ([R1](./00-critical-review.md)) |
| Soft-delete / unique-index interaction | High — replay after reversal either 404s or re-credits | Medium | Unconditional unique index + `withDeleted` on the replay re-read; documented semantics; a dedicated test |
| `@DeleteDateColumn` silently filtering ledger reads | Critical — wrong balance, silently | Medium | **`ledger_entries` has no `deleted_at` at all** ([C2](./00-critical-review.md)) |
| Balance computed from `payments` instead of `ledger_entries` | Critical — reversal breaks reconciliation | Medium | `LedgerService.balanceFor()` is the only balance source, with a comment forbidding the join |
| Concurrency spec flaky, or serialized by a size-1 pool | Medium — the bonus test proves nothing | Medium | Pool ≥ 5; `app.listen(0)`; loop the test; assert both status codes were observed |
| Test pollution between specs | Medium — order-dependent failures | Medium | Truncate and reseed in `beforeEach`; `--runInBand` |
| `migration:generate` drifting from the hand-written SQL | High — the schema does not reproduce | Medium | Write the init migration by hand; verify against a freshly dropped database before submitting |
| Model latency in the request path | Low | Medium | 3s abort, deterministic fallback, separate endpoint |
| Model hallucinating a `billId` | Medium — a cashier shown a wrong match | Medium | Validate `billId ∈ shortlist`; drop the suggestion otherwise |
| A committed API key | Critical — instant negative signal | Low | `.env` gitignored before commit 1; `.env.example` only; grep history before submitting |
| Scope creep on the AI slice | Medium — the core suffers | **High** | Hard 45-minute timebox; stub first; the real client is optional and documented as such |
| Over-abstraction hurting the live-extension exercise | Medium — cannot explain own code | Medium | Explicit `EntityManager` passing; no async-local magic; no repository layer over TypeORM |
| Running out of time | High | Medium | Build in the stated order. Steps 1–8 are the graded core; Step 9 is independent after Step 5 and can be reduced to the interface plus stub without losing the design point |

---

## 18. Definition of Done

### Functional

- [ ] All six endpoints behave per the [§8](./05-api-and-flows.md) contracts
- [ ] `DRAFT → POSTED → PAID`, `DRAFT → VOID`, `POSTED → VOID` (no payments), `PAID → POSTED` on reversal; every other transition is 409
- [ ] Replay of an `externalRef` returns 200 with one payment and one credit entry
- [ ] Reversal appends `PAYMENT_REVERSED`, soft-deletes the payment, and reopens the bill
- [ ] `GET /bills/:id` returns `balance` and `amountPaid` derived from the ledger
- [ ] `POST /reconciliation/suggest` returns candidates and a suggestion, and degrades gracefully

### Invariants

- [ ] Cross-tenant access returns 404 on every endpoint, with **zero rows written**
- [ ] `ForbiddenException` appears nowhere in `src/` (grep-confirmed **and** test-enforced)
- [ ] Money is `numeric(12,2)` in the database and a two-decimal string in every JSON field, both directions
- [ ] No `parseFloat`, no `Number(`, no arithmetic on money in TypeScript (grep-confirmed)
- [ ] Every money mutation runs in one transaction with the bill row locked first
- [ ] `SUM(ledger.amount)` equals the reported balance in every lifecycle assertion
- [ ] No hard deletes; `deleted_at` on organizations, bills, and payments; `ledger_entries` is append-only with no `deleted_at`
- [ ] `LedgerService` is the only writer of `ledger_entries` and the only source of a balance

### AI slice

- [ ] Behind `LlmClient`; the stub is the default binding and the application runs with no API key
- [ ] Timeout plus graceful degradation; the endpoint never returns 5xx because of the provider
- [ ] Suggests only — a test asserts zero writes to `payments` and `ledger_entries`
- [ ] The suggested `billId` is validated against the shortlist
- [ ] Amount parsing is deterministic and in code, never delegated to the model
- [ ] No key in the repository or in git history

### Tests

- [ ] Three required scenarios plus the concurrency bonus, all green
- [ ] Concurrency covers **both** the same-reference case and the different-references case
- [ ] The suite passes on a database created from migrations alone
- [ ] The concurrency spec is looped and non-flaky across five consecutive runs
- [ ] The isolation spec asserts row counts, not merely status codes

### Quality and documentation

- [ ] `tsc --noEmit` clean; lint clean; `synchronize: false`
- [ ] README: `docker run` Postgres, create the test database, `npm run migration:run`, `npm run test:e2e` — verified verbatim on a clean machine
- [ ] DECISIONS.md ≤ 1 page covering: numeric-not-float, the idempotency mechanism, isolation and why 404, reversal balance math, the AI feature and guardrails, and one-thing-differently (RLS + a denormalized balance cache)
- [ ] Assumptions stated in the README: trusted header, seeded organizations, single currency, immutable `amountDue`, no partial reversals
- [ ] Conventional commits, roughly ten, each independently defensible — no `wip`, no `fix stuff`
- [ ] A manual curl walkthrough of the full lifecycle performed once by hand

---

---

[← Performance & Deployment](./10-performance-and-deployment.md) · [Index](./README.md) · [Project Owner Summary →](./12-project-owner-summary.md)
