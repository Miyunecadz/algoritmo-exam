# Decisions

**Money is `numeric(12,2)`, never a float.** A double cannot represent `0.10`, so one `Number()` in
the path silently loses cents. Money is a string end to end. `node-postgres` already returns
`numeric` as a string, so the decisive move was to *not* register a numeric type parser —
`data-source.ts` says so in a comment, because adding one is the trap. Every sum and comparison
happens in SQL (`SUM`, and a `CASE WHEN` inside the status update), so no balance value reaches
TypeScript where it could be compared wrongly. `@IsMoneyString()` rejects a JSON *number* at the
boundary; that validator is the firewall.

**Idempotency comes from the database.** `UNIQUE (org_id, external_ref)` is the only real
serialization point between two simultaneous webhook deliveries — a `SELECT` then `INSERT` has a
window, and that window is what the retries occupy. So the service inserts first. On a `23505` it
discriminates on the *constraint name*: only `payments_org_external_ref_uq` is a replay, because the
ledger's partial unique indexes raise `23505` too and treating one of those as a replay would turn a
double-credit bug into a cheerful 200. The replay resolves in a **fresh** transaction, since Postgres
rejects every statement in an aborted one, and re-reads `withDeleted`. The index is deliberately
unconditional, not partial on `deleted_at IS NULL`: a processor reference names one real-world event
once, forever, so a replay after a reversal returns the reversed payment instead of re-crediting it.
**That is the one genuinely under-specified point in the brief** — the opposite reading is defensible
and would change both the index and the tests. **A known reference outranks the bill's state**: the
commonest retry of all is the webhook for the payment that closed the bill, so when the bill is no
longer POSTED the service looks the reference up (inside the bill lock, where no competing insert
can be in flight) and answers 200 replay rather than 409 — the same holds after a reversal or a
void. A genuinely new reference on a non-POSTED bill is still a 409. A replay whose payload
disagrees with the stored payment returns 200 with the original payment plus every disagreement in
`warnings: ["AMOUNT_MISMATCH_ON_REPLAY", …]`: ignoring it would hide an upstream bug, and a 409
would break the contract the processor relies on.

**Tenant isolation: one choke point, a schema backstop, and 404.** Every scoped lookup goes through
`TenantScope`, whose only failure mode is `NotFoundException` — so "404, never 403" is a property of
one file, and a spec enforces it against future edits. A 403 would confirm the record exists, letting
an attacker enumerate another tenant's bill ids by status code alone; missing and other-tenant
resources return byte-identical bodies. A *write* carrying an org id no organization owns answers
404 as well — the exception filter maps the `_org_id_fkey` violation — because a 500 there would
restore exactly the signal the 404 rule denies. Underneath, the composite foreign keys
`payments(org_id, bill_id) → bills(org_id, id)` and the equivalent on `ledger_entries` make a
cross-tenant row physically unrepresentable, whatever the service layer does.

**Reversal keeps the ledger balanced because the ledger is signed and append-only.**
`BILL_POSTED = +amountDue`, `PAYMENT_RECEIVED = −amount`, `PAYMENT_REVERSED = +amount`, so
`balance = SUM(amount)`: reconciliation is one query and a reversal needs no special-case
arithmetic, with a CHECK constraint tying each type to its sign. Reversing appends a compensating
entry, soft-deletes the payment, and never touches the original credit; status is then recomputed
from the ledger, not from a flag. The balance query deliberately does **not** join to `payments` or
filter on `deleted_at` — entries are the truth, payments are merely their origin, and filtering by
soft-delete would drop the credit while keeping the reversal. Every money transaction locks the bill
row first (`SELECT … FOR UPDATE`), always in that order, so two payments racing on one bill cannot
lose a status update and deadlock is structurally impossible; READ COMMITTED plus that lock is
enough. `ledger_entries` has no `deleted_at` at all: a column that must never be used is a trap, and
`@DeleteDateColumn` would quietly filter the balance query.

**The AI slice suggests; it never acts.** `POST /reconciliation/suggest` turns one messy bank / GCash
line into a ranked shortlist with a plain-language explanation — the daily pain in utility billing is
a cashier facing a page of unmatched lines with ambiguous references. The guardrails are the feature:
the amount is parsed by regex **in code**, the shortlist comes from one SQL query scoped to the
caller's org, and the model only ranks what we already computed. Its answer is dropped unless the
`billId` is in that shortlist — a hallucinated match shown to a cashier is the harm to avoid. A
3-second abort plus a catch-all degrades any provider failure to the deterministic shortlist with
`llmAvailable: false`, never a 5xx. The module has no write path, and a test asserts payment and
ledger counts are unchanged across every suggestion; the human records the payment. `StubLlmClient`
is the default binding, so the repo and its tests run with no key and no network. The prompt carries
the pasted line plus bill ids and balances for **one** organization and no credentials; in a real
deployment, sending that to a third party is a data-processing question needing a customer
agreement.

**One thing I would do differently with more time.** Enforce isolation in Postgres with Row-Level
Security and `SET LOCAL app.current_org` per transaction, so a forgotten `WHERE org_id` stops being
possible at all. It interacts badly with connection pooling unless every request runs inside a
transaction with the setting applied, and getting that subtly wrong would have risked the very
requirement it protects. Close behind: a denormalized `bills.balance` maintained in the same
transaction — deriving from the ledger is more provably correct, but it is a `SUM` per read and the
first thing I would cache at scale.
