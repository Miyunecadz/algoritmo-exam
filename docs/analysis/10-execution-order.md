# 10. Execution Order, Open Questions & Final Recommendation

> Part 10 of the [Mini Billing Ledger analysis](./README.md).

## Recommended Execution Order

**Phase 1 — Analysis (~15m)**
Confirm PG 15 reachable. Fix all ambiguity decisions in writing (they become DECISIONS.md). Decide the signed-ledger convention — everything else follows from it.

**Phase 2 — Design (~20m)**
Lock the schema including constraints and partial indexes. Lock the two transaction scripts (§4.3, §4.4) on paper. Pick the LLM feature and its response shape.

**Phase 3 — Implementation (~3.5h)**
Steps 1→2→3→4→5→6→7 in order (each depends on the prior), then Step 9 (LLM, independent after Step 5). Commit at each step boundary.

**Phase 4 — Testing (~1.5h)**
Isolation spec → idempotency spec → lifecycle spec → concurrency spec → LLM read-only spec. Then drop DB, re-run migrations, re-run full suite.

**Phase 5 — Final Review (~30m)**
`grep -rn "parseFloat\|Number(\|ForbiddenException\|synchronize: true" src/`. Check history for secrets. Read README as a stranger and execute the three commands verbatim. Write DECISIONS.md last, from the actual code. Rehearse the two hardest live questions: *"walk me through two simultaneous webhooks"* and *"why 404 not 403"*.

## Open Questions / Assumptions

**Would ask the interviewer if possible** (proceeding with the stated resolution regardless):

1. Should a replayed `externalRef` after reversal re-credit? → **No.** Documenting in DECISIONS.
2. Is overpayment allowed? → **Yes**, negative balance = credit.
3. Is `externalRef` unique per-org or globally? → **Per-org.**
4. Reversal of a reversed payment: 404 or 409? → **404**, consistent with soft-delete invisibility.
5. Is `POST /bills/:id/void` wanted? → building it; VOID status exists with no other way to reach it.

**Assumptions** (all labelled inline, and restated in README):

- Header trusted, no verification
- Orgs seeded by migration, no org CRUD
- Single implicit currency
- `amountDue` immutable post-POST
- No partial reversals — a payment reverses in full

**Where the spec is under-specified:** replay-after-reversal semantics (item 1) is the only genuinely load-bearing gap — it changes both the index definition and the test suite. Everything else is cosmetic. Calling it out explicitly in DECISIONS.md is worth more than picking "right", because the interviewer's own answer may differ and the reasoning is what's being graded.

## Final Recommendation

**Treat it as an invariants exercise, not a CRUD exercise.** The endpoints are 30 minutes of work; the remaining time is transactions, constraints, and tests. Spend the schema hour well — put every rule you can into Postgres (composite tenant FK, sign CHECK, partial unique indexes) so the service layer stays short enough to explain in a 30-minute walkthrough.

**Make the ledger signed.** `BILL_POSTED = +due`, `PAYMENT_RECEIVED = −amount`, `PAYMENT_REVERSED = +amount`, and `balance = SUM(amount)`. One query is the balance, reconciliation is provable in one assertion, and reversal needs no special-case math. This single choice makes non-negotiable #4 nearly free.

**Never derive balance or status from stored flags.** Recompute from the ledger inside the transaction, then write status. This is what makes post → partial → full → reverse correct without a state-machine matrix.

**Get idempotency from the database, not from application logic.** `UNIQUE (org_id, external_ref)`, insert first, catch `23505`, roll back, re-read in a fresh transaction with `withDeleted`, return 200. Add `SELECT … FOR UPDATE` on the bill in every money transaction — the unique index handles duplicate refs, the lock handles two different payments racing on one bill. Both tests needed; they fail for different reasons.

**Make tenant isolation a single choke point plus a schema backstop.** `TenantScope.*OrThrow` always throws `NotFoundException`; composite FKs make cross-tenant rows unrepresentable. Add a test asserting `ForbiddenException` appears nowhere — that turns the 404-not-403 rule into something the suite enforces.

**Keep the LLM slice deliberately small and read-only.** Bank-line match suggester: deterministic parse and SQL shortlist in code, model only ranks and explains, suggestion validated against the shortlist, 3s timeout with a still-useful fallback, stub as the default binding, and a test proving zero writes. That earns every point on the LLM rubric in 45 minutes without touching the money path.

**Ship RLS as a sentence, not as code.** Name it in DECISIONS.md as the "one thing I'd do differently" alongside a denormalized in-transaction balance cache. Both show you know where this design stops scaling; neither risks the deadline.

**Write DECISIONS.md last, from the code that exists.** Then verify the README's three commands against a freshly dropped database. A submission that doesn't start on the reviewer's machine loses more than any missing feature.

Order: scaffold → schema+constraints → money helper → tenant scope → bills → payments → reversal → tests → LLM → docs. Commit conventionally at each boundary. Nine or ten commits, each one a thing you can defend out loud.
