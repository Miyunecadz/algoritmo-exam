# 3. Scope

> Part 3 of the [Mini Billing Ledger analysis](./README.md).

## In Scope

- 4 entities, migrations, seed of test orgs
- 5 required endpoints + void
- Tenant middleware + scoped repository helper
- Money string handling + tiny minor-units helper
- Transactional services with row locking
- Global validation + exception filter
- e2e test suite against real Postgres, incl. concurrency test
- LLM match-suggestion module behind interface, stub impl + one real impl path
- Docker command, README, DECISIONS.md, conventional commits

## Out of Scope

Auth/JWT/login. Org CRUD. Users/roles. Invoices, line items, tax, currency conversion. Refund-to-processor integration. Outbound webhooks. Pagination/list endpoints. Rate limiting. Frontend. Docker Compose for the app itself (`docker run` for PG is enough per hint). CI pipeline. Observability stack. Event sourcing / outbox. Multi-currency. Partial reversals.

## Do NOT over-engineer

- ❌ Postgres RLS — real answer for tenant isolation at scale, but pooling + `SET LOCAL` per transaction adds risk and setup time. **Use as the "one thing I'd do differently" in DECISIONS.md.** Naming it there scores the judgment points without the risk.
- ❌ CQRS, event sourcing, outbox pattern, domain-event bus
- ❌ `cls-hooked` / async-local transaction propagation magic — pass `EntityManager` explicitly. Interviewer can follow it.
- ❌ Repository abstraction layer over TypeORM repositories
- ❌ Redis idempotency cache — DB unique index is the correct primitive
- ❌ `decimal.js` if a 25-line bigint-cents helper suffices
- ❌ Docker Compose + Dockerfile for the API
- ❌ Real LLM streaming, retries with backoff, prompt-versioning framework

## Priorities

- **Must:** F1–F5, F7, N1–N9, B1–B12, all four test scenarios.
- **Should:** F6 (void), N10–N11, structured error codes.
- **Nice:** health endpoint, audit table for LLM suggestions, Swagger decorators (cheap, good demo aid).

## Existing Codebase Analysis

None. `/mnt/e/projects/personal/algoritmo-exam` is empty. Greenfield — so **conventions become a deliverable**. Establish and hold them from commit 1:

- Feature-module-per-aggregate (Nest idiom), not layer-per-type
- One entity file per table, `snake_case` DB names via explicit `name:` on every column, `camelCase` in TS
- DTOs in `dto/`, never expose entities directly — explicit response mappers keep money-as-string honest
- Services own transactions, controllers stay thin, no repository access from controllers
- Every tenant-scoped read goes through the scoped-query helper
