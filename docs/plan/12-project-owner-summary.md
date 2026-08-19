# Project Owner Summary

> Part of the [Mini Billing Ledger implementation plan](./README.md). Covers section 19.

[← Risks & Definition of Done](./11-risks-and-done.md) · [Index](./README.md) · [Developer Quick Start & Final Checklist →](./13-quick-start-and-checklist.md)

---

## 19. Project Owner Summary

### What are we changing?

We are building a small billing service from scratch. It lets several customer organizations share one system while keeping their data completely separate, records what each customer owes, accepts payments against those bills, and allows a mistaken payment to be reversed without erasing any history. It also adds an AI-assisted helper that suggests which bill an unmatched bank transfer probably belongs to.

### Why are we changing it?

Three problems break billing systems in production, and all three are silent until the damage is done:

1. **One customer seeing another customer's data.** That is a breach, not a bug.
2. **The same payment being counted twice.** Payment processors legitimately retry their notifications; a system that treats each retry as new money credits customers for payments they never made.
3. **Corrections that destroy the record.** If reversing a payment simply deletes it, nobody can later explain what happened or prove the books are right.

### How will it work?

A bill starts as a draft. Posting it makes it real and records what is owed. Payments reduce the balance; when the balance reaches zero the bill is marked paid. Reversing a payment adds a correcting entry rather than deleting anything, and the bill reopens.

The key idea is that **the balance is never stored — it is always recalculated from the list of recorded movements.** Every movement, including every correction, is a permanent line in that list. Adding them up gives the balance. There is no separate number that can drift out of date, and no correction that leaves a gap.

### Why did we choose this approach?

- **The database enforces the rules, not just the code.** Separation between customers, valid amounts, and the "one payment per processor reference" rule are all enforced by the database itself. Even a future coding mistake cannot break them.
- **Money is handled as exact decimal text throughout.** Ordinary computer decimal arithmetic loses fractions of a cent; at billing volumes those add up to real, unexplainable discrepancies. This design makes that impossible.
- **Duplicate payments are prevented by the database's own uniqueness guarantee**, not by a code check. A code check can be defeated by two notifications arriving at the same instant — which is exactly when processors retry.
- **The AI only suggests.** It never records a payment. A person always makes the final decision.

### What is included?

Creating, posting, voiding, and viewing bills; recording payments safely including duplicate retries; reversing payments; a live balance for each bill; the AI matching suggestion; a full automated test suite covering separation, duplicates, the complete lifecycle, and simultaneous requests; and documentation explaining every decision.

### What is not included?

Login and user accounts (the assignment specifies an existing authentication layer upstream). Creating or managing organizations. Multiple currencies. Refunding money back to the card or bank. Any user interface. Partial reversals — a payment is reversed in full or not at all.

### What are the risks?

| Risk | How it is handled |
|---|---|
| A duplicate payment slips through under exact simultaneity | The database, not the code, enforces uniqueness — and there is a test that fires two identical requests at the same instant, repeatedly |
| A rounding error in money | Exact decimal storage; no ordinary decimal arithmetic anywhere; tests assert exact amounts down to the cent |
| One customer's data visible to another | Enforced at two independent layers, and tested by attempting the access and confirming both the refusal and that nothing was written |
| The AI suggests a wrong or invented bill | Every suggestion is checked against a list the system itself produced; anything outside it is discarded before a person sees it |
| The AI service is slow or unavailable | It is cut off after three seconds and the user still receives the system's own ranked shortlist. The feature degrades; it does not disappear |
| The build runs out of time | The AI helper is the last piece and is independent. Everything graded as core is complete before it starts |

### What will the user experience?

A cashier records a payment and immediately sees the updated balance. If the payment processor sends the same notification twice, nothing changes and no error is shown — the second one is quietly recognised as a repeat. If a payment was recorded in error, the cashier reverses it: the balance returns to what it was, the bill reopens, and the original record remains visible in the ledger for audit. When a bank transfer arrives that does not obviously belong to any bill, the cashier pastes the line in and gets a ranked list of likely matches with a plain-language explanation — then decides for themselves.

---

---

[← Risks & Definition of Done](./11-risks-and-done.md) · [Index](./README.md) · [Developer Quick Start & Final Checklist →](./13-quick-start-and-checklist.md)
