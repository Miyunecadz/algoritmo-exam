# Developer Quick Start & Final Checklist

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers sections 20, 21.

[← Project Owner Summary](./12-project-owner-summary.md) · [Index](./README.md)

---

## 20. Developer Quick Start

```text
 1. Read analysis/04-technical-approach.md and section 0 of this document (the corrections)
 2. Scaffold + data-source (synchronize: false)         → commit
 3. Entities + hand-written init migration + seed       → commit
 4. Money helper + @IsMoneyString                       → commit
 5. Tenant middleware + TenantScope + exception filter  → commit
 6. LedgerService + bills (create/post/void/get)        → commit
 7. Payments: idempotent ingestion                      → commit
 8. Payments: reversal                                  → commit
 9. Test suite (isolation, idempotency, lifecycle, concurrency)  → commit
10. AI reconciliation slice                             → commit
11. DROP the database, migrate, run the whole suite
12. README + DECISIONS.md, lint, type-check, secret sweep → commit
```

Steps 2–8 are strictly sequential. Step 10 depends only on step 6 and can move earlier if the schedule slips.

### Files Expected to Change

None — greenfield.

### Files Expected to Be Added

```text
package.json  tsconfig.json  .gitignore  .env.example  README.md  DECISIONS.md
src/main.ts
src/app.module.ts
src/database/data-source.ts
src/database/migrations/<ts>-Init.ts
src/database/migrations/<ts>-SeedOrgs.ts
src/common/tenant/{tenant.middleware.ts,org-id.decorator.ts,tenant-scope.service.ts}
src/common/money/{money.ts,money.spec.ts,is-money-string.validator.ts}
src/common/filters/all-exceptions.filter.ts
src/common/health/health.controller.ts
src/organizations/organization.entity.ts
src/bills/{bill.entity.ts,bills.service.ts,bills.controller.ts,bills.module.ts}
src/bills/dto/{create-bill.dto.ts,bill-response.dto.ts}
src/payments/{payment.entity.ts,payments.service.ts,payments.controller.ts,payments.module.ts}
src/payments/dto/{create-payment.dto.ts,payment-response.dto.ts}
src/ledger/{ledger-entry.entity.ts,ledger.service.ts,ledger.module.ts}
src/llm/{llm-client.interface.ts,stub-llm.client.ts,anthropic-llm.client.ts,llm.module.ts}
src/reconciliation/{reconciliation.service.ts,reconciliation.controller.ts,reconciliation.module.ts}
src/reconciliation/dto/{suggest-request.dto.ts,suggest-response.dto.ts}
test/jest-e2e.json
test/helpers/{app.ts,db.ts,fixtures.ts}
test/{tenant-isolation,idempotency,ledger-lifecycle,concurrency,reconciliation,no-forbidden}.e2e-spec.ts
```

### Files Expected to Be Deleted

None. (Remove the `nest new` sample `app.controller.ts` / `app.service.ts` / `app.controller.spec.ts` if the generator creates them — otherwise none.)

### Commands to Run

```bash
# Postgres — quoted verbatim from the brief's setup hint. Use this exact line;
# a reviewer will paste it from the brief, and a different name or password will not match.
docker run --name tt-pg -e POSTGRES_PASSWORD=pg -p 5432:5432 -d postgres:15

# Test database — TO VERIFY the exact form; must exist before the suite runs
docker exec -it tt-pg psql -U postgres -c 'CREATE DATABASE billing_test'

npm install
npm run migration:run       # TO VERIFY — script defined in Step 1
npm run start:dev
npm run test:e2e            # TO VERIFY — script defined in Step 1
npm run typecheck
npm run lint                # TO VERIFY — depends on whether nest new adds eslint
```

All npm scripts above are **proposed** and defined in Step 1; they do not exist yet.

### Final sweep before submitting

```bash
grep -rn "parseFloat\|Number(\|ForbiddenException\|synchronize: true" src/     # must be empty
grep -rn "deleted_at" src/ledger/                                              # must be empty
git log -p | grep -i -E 'api[_-]?key|secret|sk-ant'                            # must be empty
git log --oneline                                                              # ~10 conventional commits
```

---

## 21. Final Implementation Checklist

Working checklist — tick as you go.

**Understand**
- [ ] Read section 0 of this document (corrections to the prior analysis) before writing code
- [ ] Re-read the original assignment brief and diff it against the [§5](./03-scope-and-traceability.md) traceability table
- [ ] Confirm Postgres is reachable and the image tag is correct
- [ ] Fix the ambiguity decisions in writing — they become DECISIONS.md

**Data**
- [ ] Four entities with explicit column names and money typed `string`
- [ ] Init migration hand-written with every `CHECK`, both composite foreign keys, `payments_org_external_ref_uq` by that exact name, and both partial unique indexes
- [ ] `ledger_entries` has no `deleted_at` and no `@DeleteDateColumn`
- [ ] Seed migration with fixed organization UUIDs
- [ ] The three by-hand constraint-rejection checks from Step 2 all fail as intended

**Backend**
- [ ] `Money` helper and `@IsMoneyString()` — a JSON number is rejected
- [ ] Tenant middleware, `@OrgId()`, `TenantScope` — `NotFoundException` only
- [ ] `LedgerService` — `append`, `balanceFor`, `recomputeBillStatus`; no update or delete method
- [ ] Bills: create, post (transactional, locked), void, get
- [ ] Payments: idempotent ingestion — insert-first, constraint-name discrimination, fresh-transaction replay re-read with `withDeleted`
- [ ] Payments: reversal — payment re-selected `FOR UPDATE` **inside** the bill lock
- [ ] The controller sets 201 or 200 dynamically on `POST /payments`
- [ ] AI slice — interface, stub default, deterministic parse and shortlist, `billId` validated against the shortlist, 3s abort

**Cross-cutting**
- [ ] Global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`
- [ ] Global exception filter emitting `{ statusCode, code, message }`, never echoing driver errors
- [ ] Structured logging with `orgId`, never amounts
- [ ] The bill is locked first in **every** money transaction

**Tests**
- [ ] Harness: migrations in `globalSetup`, truncate and reseed in `beforeEach`, `app.listen(0)`, pool ≥ 5
- [ ] Isolation spec asserts **row counts unchanged**, not just the 404
- [ ] Idempotency spec covers replay, amount-mismatch replay, and cross-org same-reference
- [ ] Lifecycle spec asserts `SUM(amount)`, entry order, the untouched original row, and exact string formatting
- [ ] Concurrency spec covers both the same-reference and different-references cases, looped
- [ ] Reconciliation spec asserts zero writes
- [ ] `no-forbidden` guard spec present
- [ ] The reverse-then-replay case is tested — the sharpest case in the suite

**Verify**
- [ ] `npm run test:e2e` green five consecutive times
- [ ] `tsc --noEmit` clean, lint clean
- [ ] **Database dropped, migrations re-run from scratch, full suite green**
- [ ] Manual curl walkthrough of the full lifecycle
- [ ] The final grep sweep from §20 is clean

**Ship**
- [ ] README verified verbatim by following it as a stranger would
- [ ] DECISIONS.md ≤ 1 page, all six points, written from the code that exists
- [ ] Conventional commit history reviewed
- [ ] No secrets anywhere in history
- [ ] Rehearse the two hardest live questions: *"walk me through two simultaneous webhooks"* and *"why 404 and not 403"*

---

[← Project Owner Summary](./12-project-owner-summary.md) · [Index](./README.md)
