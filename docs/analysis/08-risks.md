# 8. Risks & Considerations

> Part 8 of the [Mini Billing Ledger analysis](./README.md).

| Risk | Impact | Mitigation |
|---|---|---|
| `numeric` silently parsed to JS number | Fails N1, silent cents loss | Never register a pg numeric parser. Assert `typeof === 'string'` in a test |
| TypeORM `save()` returns number on the in-memory entity for `numeric` | Wrong response body | Map responses from explicit DTOs; re-read after write when in doubt |
| Forgotten `org_id` filter in one query | Fails the headline requirement | Route all lookups through `TenantScope`; composite FK as backstop; isolation test |
| Check-then-insert idempotency | Double credit under race | Insert-first + `23505` catch |
| Catching `23505` inside the same transaction and continuing | PG aborts the tx; subsequent statements error | Roll back, re-read in a **new** transaction |
| No `FOR UPDATE` | Lost status update when two payments land together | Lock bill row first in every money transaction |
| Deadlock from inconsistent lock order | `40P01` errors | Always lock bill before touching payments/ledger |
| Soft-delete + unique index interaction | Replay-after-reversal either 404s or re-credits | Unconditional unique index + `withDeleted` on the replay re-read. Document the semantic |
| `@DeleteDateColumn` auto-filtering ledger reads | Balance silently wrong | Ledger entries are never soft-deleted; assert count in lifecycle test |
| Balance computed from `payments` instead of `ledger_entries` | Reversal breaks reconciliation | `LedgerService.balanceFor()` is the only balance source |
| Concurrency test flaky or serialized by a size-1 pool | Bonus test proves nothing | Pool ≥ 5; loop the test; assert both status codes observed |
| Test DB pollution between specs | Order-dependent failures | Truncate + reseed in `beforeEach` |
| `migration:generate` drifting from hand-written raw SQL | Migration won't reproduce schema | Write the init migration by hand; verify on a dropped DB before submitting |
| LLM latency in request path | Slow endpoint | 3s abort, fallback response; separate endpoint so money path never waits |
| Model hallucinating a `billId` | Cashier shown a wrong match | Validate `billId ∈ shortlist`; drop suggestion otherwise |
| Committed API key | Instant negative signal | `.env` gitignored, `.env.example` only, `git log -p \| grep -i key` before submit |
| Scope creep on LLM slice | Core suffers | Timebox to 45m, stub-first |
| Over-abstraction hurting the live-extension exercise | Can't explain own code | Explicit `EntityManager` passing, no magic |

Migration/back-compat concerns are minimal (greenfield), but still: verify the whole migration chain runs against a freshly dropped database as the final check. A migration that only works on your incrementally-built local DB is a common submission failure.
