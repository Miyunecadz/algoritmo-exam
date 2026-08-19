# Critical Review of the Prior Analysis

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers section 0.

[Index](./README.md) · [Implementation Overview & Business Context →](./01-overview-and-context.md)

---

## 0. Critical Review of the Prior Analysis

The analysis is strong and mostly correct. It is **not** copied wholesale. The following items are corrected, tightened, or explicitly rejected. Where I disagree, the corrected instruction in this document wins.

### 0.1 Corrections — defects in the prior analysis

| # | Prior analysis says | Problem | Corrected instruction |
|---|---|---|---|
| C1 | [§4.4](./03-scope-and-traceability.md) reversal script: read payment (unlocked) → lock bill → insert reversal | Lock order is inverted relative to the intent, and the payment's `deleted_at` is read **before** any lock is held. Two concurrent `DELETE /payments/:id` on the same payment both pass the `deleted_at IS NULL` check, both proceed, and only the `(payment_id, type)` partial unique index stops the double reversal — as a `23505` surfacing as a 500. | **Lock the bill first, then re-select the payment `FOR UPDATE` and re-check `deleted_at IS NULL` inside the lock.** Only then append the reversal. Losing racer gets a clean 404. See [§8.5](./05-api-and-flows.md). |
| C2 | A1: "`deletedAt` column on all entities", including `ledger_entries` | The analysis itself flags the footgun in [§8](./05-api-and-flows.md) (`@DeleteDateColumn` silently filters balance reads). Keeping a column that must never be used is an invitation to a wrong balance. | **`ledger_entries` has no `deleted_at` column and no `@DeleteDateColumn`.** Append-only is satisfied by never deleting, not by a soft-delete column nobody may use. Document this in DECISIONS.md as a deliberate reading of "never hard delete". |
| C3 | [§5](./03-scope-and-traceability.md) API table lists `amountPaid` in the `GET /bills/:id` response | Never defined anywhere. Undefined response fields are how contracts drift. | **Define it or drop it.** Defined here as `amountPaid = -1 × SUM(amount) WHERE type IN ('PAYMENT_RECEIVED','PAYMENT_REVERSED')`, i.e. net cash currently applied. DRAFT bill ⇒ `"0.00"`. See [§8.6](./05-api-and-flows.md). |
| C4 | [§7](./04-codebase-and-data-model.md): replay of the same `externalRef` with a **different amount** → 200 + original payment | Silently ignoring a payload mismatch hides a real upstream bug. But 409 breaks the "idempotent ingestion" requirement. | **Return 200 with the original payment plus `"replayed": true` and a `"warning"` field when the submitted amount differs from the stored one.** No new credit either way. Observable in tests, honest to the caller, still idempotent. |
| C5 | [§4.3](./03-scope-and-traceability.md) / [§8](./05-api-and-flows.md): "catch `23505`" | Bare `23505` catching is wrong — the ledger partial unique indexes also raise `23505`. Catching them as "replay" would return 200 for a genuine double-post bug. | **Discriminate on `error.constraint`.** Only `payments_org_external_ref_uq` means replay. Any other `23505` propagates as a 500 (a real invariant breach, and it should be loud). |
| C6 | [§4.5](./03-scope-and-traceability.md) shortlist: "`abs(balance − parsedAmount) < threshold`" | `balance` is not a column. It is a per-bill aggregate over `ledger_entries`. Written naively this is an N+1 or an invalid query. | Shortlist uses **one** query with a `LEFT JOIN LATERAL` (or grouped sub-select) computing balance per candidate bill. Concrete SQL in [§8.7](./05-api-and-flows.md). |
| C7 | [§4.4](./03-scope-and-traceability.md): `UPDATE bills SET status = (balance <= 0 ? 'PAID' : 'POSTED')` | Would resurrect a VOID bill to POSTED if a VOID bill ever had ledger rows. Today unreachable (void requires zero payments), but it is a one-token guard. | `UPDATE bills SET status = … WHERE id = $1 AND org_id = $2 AND status IN ('POSTED','PAID')`. Status recompute never touches DRAFT or VOID. |
| C8 | [§3](./02-technical-approach.md) lists `ledger_entries (org_id, bill_id)` composite FK but leaves `payment_id` as a plain FK to `payments(id)` | Asymmetric: a ledger row could reference another tenant's payment. Cheap to close. | Add `UNIQUE (org_id, id)` on `payments` and make it `FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id)`. Same pattern as bills, ~2 extra lines of migration. |

### 0.2 Trims — over-engineering removed

| # | Prior analysis proposes | Verdict |
|---|---|---|
| T1 | `Money` helper with `toMinor`, `fromMinor`, `compare`, `add`, `negate` | **Trim to `normalize`, `negate`, `toMinor`, `isMoneyString`.** All aggregation and all comparison happens in SQL (§0.3 R2), so `add` and `compare` have no caller. Do not write code without a caller in a 5-hour build. |
| T2 | `@nestjs/swagger` "cheap demo win" | **Skip.** It is 20–30 minutes of decorator noise across every DTO, and the README's curl walkthrough serves the same demo purpose. Listed under Future Improvements. |
| T3 | `AnthropicLlmClient` as a real implementation path | **Keep, but strictly timeboxed and untested by CI.** The stub is the default binding and the only client exercised in the suite. The real client exists to prove the interface is real, not to be depended on. If time runs short, ship the interface + stub and say so in DECISIONS.md — that is not a gap, it is the documented design. |
| T4 | Health endpoint (F8) | Keep — 4 lines, and the README references it. |

### 0.3 Reinforcements — decisions I am strengthening

| # | Reinforcement |
|---|---|
| R1 | **`FOR UPDATE` on the bill is the first statement of every money-mutating transaction, without exception** (post, pay, reverse, void). Uniform lock order = no deadlock, and it is one sentence to defend in the interview. |
| R2 | **Status recompute is a single SQL `UPDATE … CASE WHEN (SELECT SUM …) <= 0`.** No balance value ever crosses into TypeScript for a comparison. This removes an entire class of money-in-JS bugs by construction and is strictly simpler than reading the balance out and branching in TS. |
| R3 | **`LedgerService` is the only module allowed to `INSERT` into `ledger_entries` or to compute a balance.** Enforced by convention plus a grep-able test. Single audit point. |

### 0.4 Gaps in the analysis that this plan closes

- **Traceability was originally built second-hand** from `analysis/02-requirements.md`, because the brief was not in the repository at the time. It now is, at `docs/assignment.md`, and [§5](./03-scope-and-traceability.md) has been diffed against it — **no requirement is missing.** Two clarifications from that diff: the brief never asks for `POST /bills/:id/void` or `GET /health` (both are our additions, correctly ranked Should and Nice), and it fixes the Postgres setup command, which [§16](./10-performance-and-deployment.md) and [§20](./13-quick-start-and-checklist.md) now quote verbatim.
- Node.js version, package manager (npm vs pnpm), and the exact Postgres image tag are unstated. `TO VERIFY` — see [§16](./10-performance-and-deployment.md).
- No decision on response shape for `POST /bills/:id/post`: [§5](./03-scope-and-traceability.md) of the analysis says "bill+balance". Fixed here: **all bill-returning endpoints use one shared `BillResponseDto`**, so post/void/get are byte-identical in shape. Removes a whole category of test surprise.

---

---

[Index](./README.md) · [Implementation Overview & Business Context →](./01-overview-and-context.md)
