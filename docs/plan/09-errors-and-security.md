# Error Handling & Security

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers sections 13, 14.

[← Testing Plan](./08-testing-plan.md) · [Index](./README.md) · [Performance & Deployment →](./10-performance-and-deployment.md)

---

## 13. Error Handling

Uniform body: `{ statusCode, code, message }`. `code` is stable and machine-readable; `message` is human-readable and never contains a driver error or another tenant's data.

### Business-rule failures

| Scenario | Cause | Status / code | Message | Logging | Recovery |
|---|---|---|---|---|---|
| Missing `X-Org-Id` | Client or gateway misconfiguration | 400 `MISSING_ORG_CONTEXT` | "X-Org-Id header is required" | warn, no body | Client adds the header |
| Malformed `X-Org-Id` | Not a UUID | 400 `INVALID_ORG_CONTEXT` | "X-Org-Id must be a valid UUID" | warn | — |
| Money validation failure | Float, too many decimals, ≤ 0, non-string | 400 `VALIDATION_FAILED` | Field-level detail from `class-validator` | debug | Client corrects the payload |
| Bill not found / another tenant's | Wrong id, or cross-tenant access | 404 `NOT_FOUND` | "Bill not found" | info with `orgId` and the id | **Byte-identical in both cases — intentional** |
| Payment not found / already reversed | Soft-deleted rows are invisible to the tenant | 404 `NOT_FOUND` | "Payment not found" | info | — |
| Illegal transition | Post a POSTED bill, void a PAID bill | 409 `INVALID_BILL_STATE` | "Bill is in state POSTED and cannot be posted" | info | Client re-reads the bill |
| Payment on a non-POSTED bill | B8 | 409 `INVALID_BILL_STATE` | "Payments are only accepted on posted bills" | info | Post the bill first |
| Void with payments | B1 | 409 `BILL_HAS_PAYMENTS` | "Cannot void a bill that has payments" | info | Reverse the payments first |
| Duplicate `externalRef` | Processor retry | **Not an error** — 200 with the existing payment and `replayed: true` | — | info with `orgId` and `externalRef` | None needed; this is the designed path |
| Replay with a different amount | Upstream inconsistency | 200 + `warning: 'AMOUNT_MISMATCH_ON_REPLAY'` | — | **warn** — this indicates a real upstream bug and should be visible | Investigate upstream; no money moved |

### Technical failures

| Scenario | Cause | Behaviour | Logging | Recovery |
|---|---|---|---|---|
| `23505` on `payments_org_external_ref_uq` | Concurrent identical ingestion | Roll back, re-read in a fresh transaction, return 200 | info | Automatic |
| `23505` on any other constraint | A genuine invariant breach (e.g. double `BILL_POSTED`) | **Rethrow → 500** | **error, with the constraint name** | Loud on purpose. Silently swallowing this would hide a real bug ([C5](./00-critical-review.md)) |
| `23514` (CHECK violation) | Wrong-signed ledger amount — a service bug | 500 | error | Fix the code; the database prevented the corruption |
| `23503` (FK violation) | Cross-tenant row attempted | 500 | error | The composite FK did its job; investigate the code path |
| `40P01` (deadlock) | Inconsistent lock ordering | 500 | error | Should be unreachable: the bill is always locked first ([R1](./00-critical-review.md)). If it appears, the lock-order invariant has been broken — treat it as a defect, not as noise to retry away |
| Database unavailable | Container down, network failure | 503 `SERVICE_UNAVAILABLE`, **no partial write** | error | Transactions guarantee all-or-nothing |
| Provider timeout / error / bad JSON | Model unavailable or misbehaving | **200** with deterministic candidates and `llmAvailable: false` | warn | Graceful degradation — never a 5xx (N7) |
| Hallucinated `billId` | Model returned an id outside the shortlist | Suggestion dropped, candidates returned, warning set | warn | The cashier never sees an invented match |
| Unhandled exception | Anything else | 500 `INTERNAL_ERROR`, generic message | error with the full stack, server-side only | The filter never echoes a driver message to the client |

**Transactional guarantee.** Every money-mutating path runs inside a single `dataSource.transaction`. A failure at any point leaves no partial ledger row, no orphan payment, and no half-applied status change. The isolation spec asserts this by snapshotting row counts around rejected requests.

---

## 14. Security & Permissions

**Authentication.** None, by assignment. `X-Org-Id` is trusted as though set by an authenticated upstream gateway.

**This assumption is stated in three places** — the README, DECISIONS.md, and a comment in `tenant.middleware.ts` — because an untrusted tenant header in production code is a critical vulnerability. The reviewer needs to see the difference between "not required for this exercise" and "not understood".

**Authorisation.** Tenancy *is* the authorisation model here. There are no roles. Every tenant-scoped lookup passes through `TenantScope`, which throws `NotFoundException` and nothing else.

**Where the checks happen.**

| Layer | Check |
|---|---|
| Middleware | `X-Org-Id` present and a well-formed UUID. Never verifies existence — a valid-but-unknown org must be indistinguishable from another tenant's org |
| Controller | `@OrgId()` in every signature, passed explicitly to the service. Deliberately verbose so a missing scope is visible in a diff |
| Service | Every lookup goes through `TenantScope.*OrThrow` |
| Database | Composite foreign keys make a cross-tenant row physically unrepresentable |

**404, never 403 — and why it matters.** Returning 403 confirms that a resource exists, which lets any tenant enumerate another tenant's identifiers. Returning an identical 404 for "does not exist" and "belongs to someone else" leaks nothing. Enforced by `TenantScope`, asserted by `no-forbidden.e2e-spec.ts`, and confirmed by a grep in the final sweep.

**Input validation.** Global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`. All database access is via TypeORM parameterized queries or explicitly parameterized raw SQL — **no string interpolation into SQL anywhere**, including the AI shortlist query, which takes the parsed amount as a bound parameter.

**Secrets.** `ANTHROPIC_API_KEY` from the environment only. `.env` is gitignored **before the first commit** — adding it later leaves the key in history. Final check: `git log -p | grep -i -E 'api[_-]?key|secret|sk-ant'`.

**Data sent to the AI provider.** The prompt contains a bank line supplied by the user plus bill amounts and identifiers for **one** organization. It never contains data from another tenant, and never contains credentials. Worth one line in DECISIONS.md — in a real deployment this is a data-processing question requiring a customer agreement, and noticing that is part of the product judgment being assessed.

**Logging.** `orgId`, entity identifiers, and `externalRef` are logged; **amounts are not** (N11). One structured line per completed money transaction.

**Audit trail.** The ledger is append-only and complete: every money movement, including corrections, is a row. The acknowledged gap is that a reversed payment becomes invisible to the tenant via the API (A4); the administrative read path with `withDeleted: true` is named as future work.

---

---

[← Testing Plan](./08-testing-plan.md) · [Index](./README.md) · [Performance & Deployment →](./10-performance-and-deployment.md)
