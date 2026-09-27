# CHANGELOG

Approved additions, changes and removals. **Highest authority when sources conflict.**

Newest first.

---

## 2026-09-27 — CRM is not started; POS owns customers

**Approved by:** product owner, in chat: *"standalone only for now... inventory is there crm is
not strted"*.

### CHG-007 — Customers are the POS's own, for now

CHG-003 said CRM owns relationship depth and the POS keeps a cache. **CRM does not exist yet**, so
Phase 3 builds the customer against the POS's own table as master.

This is a sequencing change, not a reversal. `services/customers` is written as a lookup whose
source nothing outside the folder knows about — exactly how `services/items` is written — so when
CRM arrives the swap is one folder, and CHG-003's rule takes effect then.

**What this means for the ledger:** eight approved features cannot be built and are recorded
`BLOCKED` with the dependency named, not removed:

| ID | Blocked on |
|---|---|
| POS-CRM-001..007 | CRM does not exist |
| POS-CUST-013 | "View in CRM" has nowhere to go |

A button that goes nowhere is worse than no button, so the action is absent from
`WF-CUSTOMER-02` until there is a CRM to link to.

### CHG-008 — Inventory exists and is the Phase 8 target

Confirmed in the same message. Nothing changes today — the POS still reads its own `Item` table —
but Phase 8 has a real system to integrate with rather than a hypothetical one.

---

## 2026-09-27 — v2.0 baseline adopted

**Approved by:** product owner, in chat.

`ScaleEzy_BUILD_READY_MASTER.md` v2.0 is copied in verbatim as `MASTER.md` and is now the
authoritative execution baseline. `PLAYBOOK.md` is the build-process companion. Neither file is
edited here — changes to the baseline are recorded as entries in this file.

### CHG-001 — The 768px rule is retired

**Was:** the till hid itself below 768 px and said selling is a counter job. Decided 17 Sep 2026,
shipped in Inventory's counter sale, and carried into the POS skeleton on 26 Sep.

**Now:** phone, tablet and desktop are all first-class. `MASTER.md` §16.1.

**Impact:** `frontend/src/index.css` carries the media query that hides `.till`, and
`frontend/src/App.jsx` renders the narrow notice. Both are removed in Phase 0. Every screen from
here owes phone, tablet and desktop behaviour.

**Cost recorded:** camera scanning is a different input path from a keyboard-wedge scanner and
**cannot** meet the 150 ms target. Two speed contracts now apply — see CHG-002.

### CHG-002 — Two speed contracts, not one

**Added because** `MASTER.md` states a single `<150ms` target (POS-SELL-003) while also requiring
phone camera scan (POS-SELL-004). These cannot both hold on one number.

- **Counter / keyboard-wedge scanner:** 150 ms from scan to visible basket line. Unchanged.
- **Phone camera:** judged on "reads the barcode first try, in shop lighting". No 150 ms claim.

Nothing is dropped; the target is made honest per device.

### CHG-003 — CRM enters the architecture

**Was:** the POS owned its `Customer` table outright.

**Now:** CRM owns relationship depth; POS holds a compact selling cache keyed by phone, the same
shape as `Item` caching Inventory. `MASTER.md` §3, §6.13, §16.4.

**Impact:** `Customer` in `prisma/schema.prisma` keeps its columns but its role changes from master
to cache when CRM is enabled. Standalone mode keeps it as master. No migration needed yet; the
distinction is enforced at the service layer in Phase 3.

### CHG-004 — Product spec PDF superseded

`D:\villy\pos\ScaleEzy-POS-Product-Spec.pdf` and its sources in `D:\villy\pos\spec\` are
**SUPERSEDED**, not deleted. It conflicts with the baseline in exactly two places: it mandates the
768 px rule (see CHG-001) and it has no CRM (see CHG-003). Everything else in it — the money rules,
invoice numbering, the four limited resources, reserve-then-confirm, the ported webhook models —
survives and is reflected in `CONTRACTS.md`.

Kept because it carries the *reasons* behind decisions that `MASTER.md` states as rules.

`D:\villy\inventory\PLAN-billing-pos.md` is likewise superseded as an authority and retained as
history. It is held by a parallel session; this repo does not write to it.

### CHG-005 — Registry lives in the backend repo

`docs/product/` sits in `D:\villy\pos\backend` rather than at the module root, because the root is
not a git repository and a ledger with a changelog needs version history. The frontend repo reads
it across the disk.

### CHG-006 — Feature IDs retrofitted

The 28 partial features built on 26–27 Sep were built before IDs existed. They are mapped to
baseline IDs in `FEATURES.md` rather than renumbered or rebuilt.

---

## Pending decisions

| # | Question | Blocking |
|---|---|---|
| 1 | Supabase Singapore connection strings | Nothing local; blocks any deployment |
| 2 | Does CRM exist yet as a module, or is POS standalone-only for now? | Phase 3 scope |
| 3 | Is Inventory's Part 2 (keep-for-customer) still being built there, or does it wait for POS Phase 5? | Duplicate work risk |
| 4 | Offers: extract the shared package now or after the POS works? | Phase 4; cheap now, expensive after two copies exist |
| 5 | **GST rates are out of date and the seed overcharges sarees.** Raised 27 Sep by the Inventory session, which has built GST there. `money.service` assumes clothing is 5% and 12%; the 12% slab was removed on 22 Sep 2025. Sarees are fabric at a flat 5%; stitched apparel is 5% up to Rs 2,500 per piece and 18% above. The seed has kanchipuram silk at 12% -- about Rs 774 too much tax on a Rs 12,999 saree. Slabbed apparel also cannot be priced tax-inclusive near the threshold (no self-consistent rate between roughly Rs 2,625 and 2,950). Inventory now has a pure, tested GST engine. **Decide: adopt it via a shared package, copy it, or fix the POS in place.** Confirm the rates with the shop's accountant before anything goes live. | Every bill's tax figure |
| 6 | A kept order takes its invoice number at creation (carried from Inventory since 17 Sep). An advance for goods not yet supplied may strictly need a receipt voucher now and the invoice at handover. | Kept orders' GST paperwork; accountant's call |
| 7 | **Cancelling a kept order that still owes money.** Phase 6 refuses a return on any bill with money owed ("collect it first"). A customer who paid Rs 500 on a Rs 1,299 order and then cancels needs a different answer: refund the Rs 500? keep it as credit? forfeit it? That is a shop policy, not a code choice. | Kept-order cancellations only; paid-up orders and all counter sales return normally |
| 8 | **Confirm the money-back cap** (CONTRACTS §1.8): what was paid in store credit or exchange credit comes back only as store credit. Chosen in Phase 6 to stop credit turning into cash; some shops will want a manager to be able to override it. | Nothing -- built and working; confirm or overturn |
