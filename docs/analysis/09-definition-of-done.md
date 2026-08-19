# 9. Definition of Done

> Part 9 of the [Mini Billing Ledger analysis](./README.md).

## Functional

- [ ] All 5 required endpoints + void behave per the API table
- [ ] DRAFT→POSTED→PAID|VOID enforced, illegal transitions 409
- [ ] Replay of `externalRef` → 200, one payment, one credit entry
- [ ] Reversal appends `PAYMENT_REVERSED`, soft-deletes payment, reopens bill
- [ ] `GET /bills/:id` returns balance derived from ledger

## Invariants

- [ ] Cross-org access returns 404 on every resource, zero rows written
- [ ] No `ForbiddenException` anywhere
- [ ] All money `numeric(12,2)` in DB, strings with 2 decimals in JSON
- [ ] No `float`/`parseFloat`/JS-number arithmetic on money (`grep` to confirm)
- [ ] Every money mutation in one transaction with bill row locked
- [ ] `SUM(ledger.amount)` equals reported balance in every lifecycle test
- [ ] No hard deletes; `deletedAt` on all entities; ledger append-only

## LLM

- [ ] Behind `LlmClient` interface, stub is default binding
- [ ] Timeout + graceful degradation, endpoint never 5xx from provider failure
- [ ] Suggests only; test asserts zero writes to payments/ledger
- [ ] Suggested `billId` validated against shortlist
- [ ] No key in repo or history

## Tests

- [ ] 3 required scenarios + concurrency bonus, all green
- [ ] Passes on a freshly created DB from migrations alone
- [ ] Concurrency spec looped, non-flaky over 5 runs

## Quality / docs

- [ ] `tsc --noEmit` clean, lint clean, `synchronize: false`
- [ ] README: `docker run` PG, `npm run migration:run`, `npm run test:e2e`
- [ ] DECISIONS.md ≤1 page covering: numeric-not-float, idempotency mechanism, isolation + why 404, reversal balance math, LLM feature + guardrails, one-thing-differently (RLS + denormalized balance cache)
- [ ] Conventional commits, no `wip`/`fix stuff`
- [ ] Manual curl walkthrough of full lifecycle done once by hand
