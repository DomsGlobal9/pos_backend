# BUILD PLAN AND COVERAGE

Phase order is `MASTER.md` §10. Each phase must leave the product usable.

| Phase | Outcome | Status |
|---|---|---|
| 0 | Foundation + responsive shell | **COMPLETE** 2026-09-27 |
| 1 | Sell + cash + receipt + bill history | **COMPLETE** (POS-RCPT-002 closed in Phase 10) |
| 2 | UPI/card/split + payment safety | **COMPLETE** 2026-09-27 |
| 3 | Customer + CRM seam | **COMPLETE** for the customer; CRM half BLOCKED (CHG-007) |
| 4 | Discounts/overrides + approvals | **COMPLETE** 2026-09-27 (the 2 return approvals closed in Phase 6) |
| 5 | Orders/keep/dues | **COMPLETE** 2026-09-27 |
| 6 | Returns + exchange | **COMPLETE** 2026-09-27; stock and CRM effects BLOCKED on Phase 8 / CRM |
| 7 | Shift + cash movements + day close | **COMPLETE** 2026-09-27 |
| 8 | Inventory seam + standalone | **IN PROGRESS** -- POS side built; Inventory side being built by the Inventory session to `INVENTORY-CONTRACT.md` (catalogue, stock, sale intake done; exchanges, holds to come); real end-to-end run pending |
| 9 | Operational reports | **COMPLETE** 2026-09-27 |
| 10 | Digital receipts + devices | **COMPLETE** for what can be built 2026-09-27; SMS, email, card terminal and UPI auto-confirm wait on providers (decision #12), WhatsApp on a module key (#13) |
| 11 | Offline Stage 1 / sync UX | PLANNED |
| 12 | Public API + webhooks + CSV/Excel | PLANNED |
| 13 | Real-shop pilot + cut-over | PLANNED |

> **Note on order.** Sell, cash and receipt were built on 26–27 Sep against the superseded spec,
> before the v2.0 phase order existed. They are real and tested, but desktop-only and without
> feature IDs. Phase 0 brings them up to the shell; Phase 1 then completes them (variant picker,
> images, bill history, PDF, reprint) and takes them to `DONE`.

---

# Phase 0 — Foundation + responsive shell

**Gate:** core guards, mobile shell, money/idempotency/numbering/auth pass.

## In scope

| ID | Feature | Why now |
|---|---|---|
| POS-CORE-001 | Responsive shell | Everything else inherits it |
| POS-CORE-005 | Human service health | Already built; needs to reach Home |
| POS-CORE-006 | Basket crash/refresh recovery | Built; verify on phone |
| POS-HOME-001 | New Sale CTA | The one primary action |
| POS-HOME-002 | Today sales total | Real data exists |
| POS-HOME-003 | Bill count | Real data exists |
| POS-HOME-006 | Human sync/connection status | Reuses health |
| POS-HOME-007 | Recent activity feed | Sales only for now |
| POS-SYNC-001 | Online state | |
| POS-SYNC-002 | Unstable connection state | Needs the "work is safe" sentence |
| — | Retire the 768px rule (CHG-001) | Blocks every mobile feature |

## Explicitly NOT in scope, and why

| ID | Reason |
|---|---|
| POS-HOME-004 | BLOCKED — no Order data until Phase 5. Tile is hidden, not faked with a zero |
| POS-HOME-005 | BLOCKED — no Shift service until Phase 7 |
| POS-CORE-002 | Gateway auth mounted in Phase 3 with real sign-in; `devActor` stands in and refuses production |
| POS-CORE-003 | Permission enforcement lands in Phase 4 with approvals |
| POS-SELL-004 | Camera scan is Phase 10 |

## Files

**Create — backend**
```
src/services/home/home.service.ts      today's totals, bill count, recent activity
src/services/home/index.ts             barrel
src/routes/home.routes.ts              GET /api/v1/home/summary
src/scripts/verify-home.ts             suite
```

**Create — frontend**
```
src/AppShell.jsx                       nav + outlet, responsive
src/components/NavBar.jsx              bottom bar (phone/tablet), left rail (desktop)
src/pages/Home.jsx                     WF-HOME-01
src/pages/Orders.jsx                   WF-ORDERS-01 honest empty state
src/pages/Customers.jsx                WF-CUSTOMERS-01 honest empty state
src/pages/More.jsx                     WF-MORE-01
src/lib/useMedia.js                    one place that decides phone/tablet/desktop
```

**Modify**
```
src/routes/index.ts                    mount home routes
src/App.jsx                            router; REMOVE the narrow notice
src/index.css                          REMOVE the below-768px hide; responsive tokens
src/pages/Till.jsx                     becomes the Sell route; header moves to the shell
src/main.jsx                           BrowserRouter
```

**Remove:** nothing. CHG-001 removes two blocks of code, both recorded above.

## Coverage — Phase 0

Filled at close, not before.

```text
REQUIRED FEATURES:       11/11 accounted
IMPLEMENTED:              9/9  (2 BLOCKED with dependencies named)
FLOW LINKS:              13/13
SCREEN ACTION LINKS:     13/13  (no dead buttons; 6 disabled with a visible phase)
PHONE P0:                 3/3  (Home, Sell, More — full sale completed at 375px)
TABLET P0:                3/3
DESKTOP P0:               3/3
TESTS:                  100/100 passing
                                 verify-money      47
                                 verify-sale       48
                                 verify-responsive  5
UNAPPROVED REMOVALS:      0
UNACCOUNTED FEATURES:     0
BLOCKERS:                 2  (POS-HOME-004 needs Phase 5, POS-HOME-005 needs Phase 7)

STATUS: COMPLETE
```

## What Phase 0 actually proved

- A full cash sale completed on a **375 px phone**: `INV/2026-27/0081`. The payment sheet fits the
  viewport exactly and nothing scrolls sideways at any size.
- The shell reflows **live**, not just on load. Verified in real Chrome because the in-app browser
  pane swaps the viewport without dispatching `resize` or `matchMedia` events — measured, both
  counters stayed at zero. `verify:responsive` exists so that path is never assumed again.
- Two bugs found by looking at output rather than at code: the trading date was labelled with
  yesterday (`toISOString` converting local midnight back to UTC), and a completed basket could
  return after a reload with a fresh once-key, which would have written a second real sale.

## Carried into Phase 1

| Item | Why it is not Phase 0 |
|---|---|
| Sell keyboard map (F2, Delete, F9) | Needs the full basket interactions of Phase 1 |
| `WF-SALES-01` bill history | P0 and the next thing to build |
| `POS-RCPT-002` PDF, `-003` reprint, `-004` duplicate marking | Need the Bills screen to reach them |
| `POS-SELL-006` variant picker, `-007` images | Need `Item.imageUrl` |

---

# Phase 1 — Sell + cash + receipt + bill history

**Gate:** a real cash sale can be made, found and reprinted on all devices. **Passed 2026-09-27.**

```text
REQUIRED FEATURE IDS:    41 accounted
DONE:                    27
BUILDING:                 1  (POS-SALE-009 view customer — needs Phase 3)
PLANNED IN-PHASE:         2  (POS-SELL-006 variant picker, -007 images)
BLOCKED:                  1  (POS-RCPT-002 server-rendered PDF — reason recorded)
DEFERRED TO PHASE 6:     10  (return, exchange, void from a bill)
SCREENS:                  7/24 built, all three devices each
SCREEN ACTION LINKS:     21/21   no dead buttons
TESTS:                  127/127 passing
                                 verify-money      47
                                 verify-sale       48
                                 verify-bills      27
                                 verify-responsive  5
UNAPPROVED REMOVALS:      0
UNACCOUNTED FEATURES:     0

STATUS: GATE PASSED, PHASE NOT CLOSED
```

**The phase is not marked COMPLETE**, because three of its own features are still open. The gate
is a different thing from the phase, and conflating them is how a checklist starts lying.

| Still open in Phase 1 | Why |
|---|---|
| `POS-SELL-006` variant picker | `Item.variantGroup` is in the schema; the sheet is not built |
| `POS-SELL-007` product images | `Item.imageUrl` is in the schema; nothing renders it |
| `POS-RCPT-002` server-rendered PDF | BLOCKED on purpose — a second renderer of one bill is how a reprint stops matching the original. Waits for Phase 10 |

## What Phase 1 proved

- A bill can be found by the **last four digits** of a creased receipt, which is how a customer
  actually arrives.
- **Reprints are marked.** Copy 1 is the original; copy 2 prints `DUPLICATE · COPY 2`. Verified in
  the browser, not just in a test.
- The bill opened from history is **the same component** as the receipt printed at the counter, so
  a reprint cannot drift from the paper a customer is holding.
- Paging survives a sale landing mid-scroll. Keyset, not offset — verified by making a sale
  between page one and page two and asserting nothing repeated.

---

# Phase 2 — UPI, card, split, payment safety

**Gate:** payment retry and unknown scenarios pass. **Passed 2026-09-27.**

```text
REQUIRED FEATURE IDS:    7 accounted   (POS-PAY-005..008, -010, -011, POS-SET-003)
DONE:                    7
PLUS Phase 1 leftovers:  2   (POS-SELL-006 variant picker, -007 images)
SCREENS:                 9/24 built, all three devices each
TESTS:                 203/203 passing
                                verify-money       47
                                verify-sale        49
                                verify-bills       27
                                verify-payments    48
                                verify-variants    27
                                verify-responsive   5
UNAPPROVED REMOVALS:     0
UNACCOUNTED FEATURES:    0

STATUS: COMPLETE
```

## The rule this phase exists for

> A customer pays 4,500 rupees by UPI. The shop's phone has not dinged. The saree is in their hand
> and there is a queue behind them.

A till with two buttons forces the cashier to wave them off unpaid or ask them to send it again.
The second is what gets a shop a reputation. So there is a third answer: **not confirmed yet**. The
sale completes, the customer leaves, and the payment lands on `WF-PAY-02` to settle against the
bank — resolved to COLLECTED or VOID, never silently deleted.

Cash is deliberately excluded from it. Cash is in the drawer or it is not, and the person holding
it is standing there; allowing uncertainty would hand a cashier a way to record money they never
took.

## Three things found by testing rather than by reading

| Found | Was |
|---|---|
| Variant grouping made search **worse** | Three colours each rendered their own row saying "3 colours and sizes". The count was added without collapsing. Now one row, "from ₹12,999", picker behind it |
| Sizes sorted as text | `L, M, S, XL` for letters and `10, 38, 8` for numbers. Now letters run in wearing order and numbers sort numerically |
| Complete was below the fold on a phone | A three-way split made the panel taller than a 375px screen, so the primary action needed a scroll to find. Now sticky |

## Carried forward

| Item | Where |
|---|---|
| `POS-RCPT-002` server-rendered PDF | BLOCKED, Phase 10 — one renderer, not two |
| `POS-SALE-009` view customer from a bill | Phase 3, needs customers |
| `POS-PAY-012/013` real UPI and card provider integration | Phase 10. The needs-checking state is already the seam they will plug into |

---

# Phase 3 — Customer (standalone; CRM not started)

**Gate:** lookup, create, history work and failure degrades safely. **Passed 2026-09-27.**

```text
REQUIRED FEATURE IDS:   24 accounted
DONE:                   13
BLOCKED - no CRM:        8   (POS-CRM-001..007, POS-CUST-013)
BLOCKED - other phases:  2   (POS-CUST-011 Orders, POS-CUST-012 store credit)
PLANNED:                 1   (POS-CUST-015, Phase 6)
SCREENS:                12/24 built, all three devices each
TESTS:                 258/258 passing   (verify-customers adds 55)
UNAPPROVED REMOVALS:     0
UNACCOUNTED FEATURES:    0

STATUS: COMPLETE for what can be built
```

## The failure this phase is designed against

The phone number is the identity, so two ways of writing it must produce one record. Otherwise a
cashier types `09876543210` on Tuesday and `+91 98765 43210` on Friday, a second customer appears,
and from then on that person has two visit counts and two lifetime spends. Nobody notices until
they say "I have shopped here for years" and the screen says first visit.

All seven of these are now one person: `9876543210`, `98765 43210`, `+91 9876543210`,
`09876543210`, `0919876543210`, `(098) 76543210`, `+919876543210`.

A number that cannot be made sense of is **refused, not guessed** — "An Indian mobile number starts
with 6, 7, 8 or 9" — because a wrong number saved silently is a record nobody can ever find again.

## Two rules the screens enforce

**Skip is as prominent as Use.** Someone paying cash who will not give a number is a normal
Saturday. A sheet that makes a cashier feel obliged to fill it in gets fake numbers typed into it,
which is worse than no customer — a fake number becomes a permanent record that splits someone
else's history.

**Consent only ever goes on.** A counter screen without the tick is not the customer saying no; it
is usually nobody having asked. Tested: a later sale with the box unticked does not withdraw it.

## Found by testing

| Found | Was |
|---|---|
| Searching any name without a digit in it **crashed the screen** | A NUL byte used as a "match nothing" sentinel, which Postgres rejects outright: `invalid byte sequence for encoding "UTF8": 0x00`. Found by searching for a name that does not exist — the most ordinary thing a cashier can type |

## What CRM will change, and what it will not

`services/customers` is written as a lookup whose source nothing outside the folder knows about —
the same shape as `services/items`. When CRM arrives, the swap is that one folder plus the outbox.
No screen changes, because no screen knows where a customer came from.

---

# Phase 4 — Discounts, price overrides, in-place approval

**Gate:** manager-in-place approval and audit pass. **Passed 2026-09-27.**

```text
REQUIRED FEATURE IDS:   13 accounted
DONE:                   10
BUILDING:                1   (POS-SET-008 — PIN setting is owner-only; no settings screen yet)
BLOCKED:                 2   (POS-APR-004/-005 — return approvals, Phase 6)
TESTS:                 300/300 passing   (verify-approvals adds 42)
UNAPPROVED REMOVALS:     0
UNACCOUNTED FEATURES:    0

STATUS: COMPLETE
```

## How "no cashier logout" actually works

A manager walks to the till, types a 4-digit PIN over the open sale, and walks away. The cashier
keeps their session, their basket, their entered payments and the customer at the counter. Verified
in the browser: the approval sheet opens ON TOP of the payment sheet, which is still there
underneath, and the finished receipt still names the cashier.

A PIN authorises one action and proves nothing else — it cannot sign in, open settings or read a
report. That is why four digits is enough, and why it is safer than the alternative: a manager
signing in properly logs the cashier out mid-sale, and in a real shop ends with the manager's
password on a sticky note by the till.

## What still says no

| Case | Answer |
|---|---|
| A real PIN, typed correctly, by someone without the right | "Ravi (senior cashier) is not allowed to approve a discount above the limit." |
| No reason, or "na" | "Say why a discount above the limit is being allowed." |
| Five wrong PINs | Locked for 60 seconds — even the right PIN is refused in that window |
| Two managers sharing a PIN | Refused. Recording it against whichever row came back first would put a name against something that person never did |
| A manager typing their own PIN for their own request | Refused. Two names on an approval must be two people |
| A PIN from another shop | Not recognised — managers belong to their own shop |

## Two bugs found by testing, both in the audit trail

| Found | Was |
|---|---|
| **The audit trail recorded things that never happened** | Audit rows were written from inside the sale's transaction using the global database client — which is not part of the transaction. A sale that failed on its payment rolled back while its "discount over the limit" row stayed. Caught by a test written to check exactly that. Entries are now collected during the transaction and written only after it commits |
| **Manager approvals were missing from the audit screen** | The owner's own discounts were audited but the ones their managers approved were not — exactly backwards, since those are what an owner is checking up on. Now every granted approval writes an `approval.granted` entry naming both people |

And one test that passed for the wrong reason: the "PIN from another shop" case went through
`completeSale`, which fails on the item lookup before the PIN is ever checked. It passed without
proving anything about PINs. Rewritten to call `grant()` directly.

## An honest limitation

**The PIN lockout is in memory, per process.** A second server instance has its own counter and a
restart clears it. Right-sized for a shop's own till, where the realistic attacker is a cashier with
a minute alone rather than a script. A deployment behind a load balancer needs it in the database or
Redis, and that is a real limitation, not a detail.

---

# Phase 5 — Orders: keep for customer, advances, dues, handover, park

**Gate:** advance, due, collect, ready and handover pass. **Passed 2026-09-27.**

```text
REQUIRED FEATURE IDS:   20 accounted
DONE:                   20
UNBLOCKED:               2   (POS-HOME-004, POS-CUST-011 -- both waiting on this phase)
SCREENS:                15/24 built, all three devices each
TESTS:                 393/393 passing   (verify-orders 63, verify-held-bills 30)
UNAPPROVED REMOVALS:     0
UNACCOUNTED FEATURES:    0

STATUS: COMPLETE
```

## One word for the shop, two facts underneath

"Orders" is the word a shop uses. Underneath are two independent questions -- where are the goods
(Waiting / Ready / Handed over) and is money owed -- kept in two columns. The four tabs are
filters over them, so an order that is Ready and still owes 800 appears under both. A single
status would have to hide one of those, and "READY_BALANCE_DUE_PARTIALLY_COLLECTED" is how a
cashier stops knowing what to do next.

Parked bills are deliberately NOT orders. A parked bill is a cashier's draft -- no invoice, no money,
nothing kept for anyone. MASTER keeps them on separate screens and so does this.

## Found while building, not reported

| Found | Was |
|---|---|
| **`Sale.status` drifted from the truth** | It is a stored summary of the payments, and payments change after a sale. Checking an unconfirmed UPI and finding it never arrived left the bill saying COMPLETED while money was owed on it. `refreshMoneyStatus` now runs wherever a payment changes -- including Phase 2's `resolve()` -- and it applies to counter sales too |
| **A zod default broke every existing caller's types** | Defaulting `kind` to COMPLETE made it REQUIRED in the inferred type, which would have broken every suite that never mentioned it. `tsc` excludes `src/scripts/`, so the app typecheck passed. There is now `npm run typecheck`, which checks the suites as well |
| **A test that passed once and failed on the rerun** | It summed a customer's debts by NAME, and each run creates a new customer with the same name. The code was right; the check was not. Now it counts the orders it made, by id -- and was run twice to prove it |

## The two rules that protect real money

- **Two cashiers, one balance.** Collecting takes a row lock on the sale before reading what is
  owed. Five concurrent attempts to collect the whole balance: exactly one succeeds, and the
  customer pays once.
- **Money being checked is not money owed.** A UPI still being checked is excluded from "due", or
  the Orders screen would tell the next cashier to ask for it again. Once the bank says it never
  arrived, it is owed again -- automatically.

## Open question recorded, not decided

A kept order takes its GST invoice number at creation, following the decision that has run in
Inventory's counter sale since 17 Sep 2026. Strictly, an advance for goods not yet supplied may call
for a receipt voucher now and the invoice at handover. That is a compliance question for the shop's
accountant, and is in CHANGELOG pending decisions rather than changed quietly.

---

# Phase 6 — Returns, credit notes, store credit, exchange

**Gate:** credit note, customer effects and difference settlement pass. **Passed 2026-09-27**, with
stock effects BLOCKED on the Phase 8 Inventory seam and CRM effects on CRM existing.

```text
REQUIRED FEATURE IDS:   26 accounted
                        (RET-001..009, EXC-001..006, APR-004/005, SALE-010..012,
                         PAY-015/016, CUST-012, CUST-015, SET-006)
DONE:                   20
BUILDING:                2   (CUST-012 -- store credit done, loyalty points not the POS's yet;
                              SET-006 -- window enforced, no settings screen)
BLOCKED:                 3   (RET-008, EXC-006 -- Inventory seam, Phase 8; RET-009 -- no CRM)
UNBLOCKED:               2   (APR-004, APR-005)
SCREENS:                17/24 built, all three devices each
TESTS:                 518 backend + 33 UI in real Chrome + 5 responsive, all passing
UNAPPROVED REMOVALS:     0
UNACCOUNTED FEATURES:    0

STATUS: COMPLETE for what can be built
```

## What a return is

A **credit note against one bill**: which lines, how many, why, and how the money goes back. It has
its own number series (`CN/2026-27/0001`), because GST requires credit notes to be counted apart
from invoices. An exchange is a return whose credit pays for a new bill first, with only the
difference changing hands -- the credit note and the new bill are written in one transaction, and
each points at the other.

Nothing on the original bill changes except its status, and only when every piece has come back.
The receipt a customer is holding stays true; the credit note sits beside it.

## Decisions made in this phase, and why

| Decision | Why |
|---|---|
| A piece comes back at **what was paid for it**, not the tag | A saree bought at 20% off must not refund at full price. Cumulative rounding makes a whole bill returned piece by piece add up to exactly what was paid |
| **No refund while a payment is being checked or money is owed** | Refunding a UPI that never arrived is paying it out. Kept-order cancellation with a debt is decision #7 |
| **Money back only up to money paid** | Otherwise store credit becomes cash by buying and returning. Decision #8 asks the owner to confirm |
| Outside the window, **one** PIN | A manager allowing a late return is allowing the return. Two PINs for one saree is theatre |
| The exchange's new bill uses the **sale's own code** | `writeSale` was split out of `completeSale` so an exchange can never price a saree differently from the counter |

## Found while building

| Found | Was |
|---|---|
| **The FEATURES header count was wrong** | Phase 5's summary said DONE 92; the rows said 100. It had been updated by arithmetic while rows changed. Now counted from the rows by script |
| **A spend race the test design exposed** | The UI test tried to spend store credit that the earlier exchange had already used. The server refused ("no store credit left") -- the right answer; the test was fixed, not the code |
| **Prisma rejects a second relation between the same two tables without names** | `Return.exchangeSale` needed the originals renamed (`ReturnOriginalSale`). Relation names only; no database change |

## Store credit, and why it cannot be spent twice

Spending is ONE statement with the check inside it -- `UPDATE ... SET balance = balance - x WHERE
balance >= x`. Two tills at once: Postgres runs them one after the other on the row, and the second
updates nothing. Tested with two concurrent sales of the whole balance: one sale, balance zero. The
database also carries `CHECK (store_credit_paise >= 0)`, so a future path that forgets the guard
fails loudly. Every change writes a ledger row, shown on the customer card with the credit note or
invoice that caused it.

## Not touched, on purpose

**Stock.** A POS sale does not move stock today; the Inventory seam is Phase 8. So a return does not
either, and the two are in step. The credit note already holds what the Phase 8 event needs.

**GST rates.** A return reverses exactly the tax the original bill charged, read from the stored
line. So when decision #5 fixes the rates, old bills and their returns stay consistent with each
other -- the fix changes future bills only.

---

# Phase 7 — Shift, drawer and day close

**Gate:** expected vs counted, variance, overnight warning and an immutable day close pass.
**Passed 2026-09-27.**

```text
REQUIRED FEATURE IDS:   15 accounted  (SHIFT-001..009, DAY-001..005, HOME-005)
DONE:                   15
UNBLOCKED:               1   (POS-HOME-005, waiting on this phase since Phase 0)
SCHEMA GAP CLOSED:       1   (cash movement model)
SCREENS:                20/24 built, all three devices each
TESTS:                 587 backend + 66 UI in real Chrome + 5 responsive, all passing
UNAPPROVED REMOVALS:     0
UNACCOUNTED FEATURES:    0

STATUS: COMPLETE
```

## What the owner gets at 9 pm

One page per day: what was sold and how it was paid, what went back, what the drawers should hold,
what they were counted at, and the difference -- plus anything still unsettled (a shift left open,
a UPI still being checked, a bill not synced). Once closed, that page is frozen; anything later
shows on its own "since closing" line.

## Decisions made in this phase, and why

| Decision | Why |
|---|---|
| Cash is tied to a drawer on each **payment/refund row**, not the sale | A kept order's balance collected on Saturday belongs in Saturday's drawer |
| **Blind count**, refused without the figure when it does not match | A count that is shown the answer first is a copy, not a count. Recounting is allowed -- real shops do -- and every attempt is audited |
| Cashiers do not see the expected figure while open | Same reason. Managers do. A closed shift's difference is shown to everyone |
| **A sale is never blocked** by a missing shift | The customer at the counter is served; the bar says the cash won't count, and the day close shows it separately. Decision #9 asks the owner to confirm |
| Cashier's cash OUT needs a manager's PIN | MASTER §8 leaves cash in/out "policy-controlled" for cashiers; money out is the risky direction. Decision #9 |
| Closing a day with a shift open needs an explicit yes | Same shape as handing over an order with money owed |

## Found while building

| Found | Was |
|---|---|
| **The QA header count was off by one** | Said PARTIAL 4 / PLANNED 4; the rows said 3 / 5. Now counted by script |
| **A test that looked like a product bug** | The close stored an expected figure of Rs 448 against Rs 2,698 on screen. Traced: the test's hand-sum missed one Rs 449 sale, so its "more than the drawer" cash-out was genuinely allowed and every later figure moved. The code was right; the test was fixed |
| **A `@db.Date` column stores the day before** if handed local midnight | Local midnight in Chennai is 18:30 UTC the previous day. The day-close key is built as UTC midnight of the calendar date; tested |

## Testing both people

The dev server acts as the cashier. The UI suite starts a second backend on 4008 with
`DEV_ACTOR=dev-manager` and routes the browser's API calls to it for the manager half, so the blind
count (cashier) and the day close (manager) are both driven through the real screens.

---

# Phase 9 — Operational reports

**Gate:** all P0 reports reconcile to source transactions. **Passed 2026-09-27.**

```text
REQUIRED FEATURE IDS:   11 accounted (RPT-001..011)
DONE:                   11
SCREENS:                21/24 built, all three devices each
TESTS:                 727 backend + 86 UI in real Chrome + 5 responsive, all passing
UNAPPROVED REMOVALS:     0
UNACCOUNTED FEATURES:    0

STATUS: COMPLETE
```

## How "reconcile" is proven

`verify-reports` builds one past day of known activity -- two cashiers, two counters, a discount
approved by a manager, a price change, a split payment, a return, an exchange, a kept order still
owing, a drawer counted Rs 100 short -- and checks each section to the paisa against the rows. Then
it checks the sections against each other (cashiers add up to the day, counters add up to the day,
taxable + tax + round-off = net sales) and against the day close, which adds the same rows up a
different way. Nothing in the reports is a stored total.

## Decisions

| Decision | Why |
|---|---|
| A cashier sees their own bills, today, and nothing else | MASTER §8 says "limited"; "how is my day going" is useful, anyone else's figures are not theirs |
| Money in is dated when it was taken, not when the bill was made | A kept order's balance collected today is today's money -- the drawer and the day close agree |
| Dues are "as of now" whatever the period | A debt does not belong to a date range |
| New permission `report:view` (manager, owner) | Rows, not an enum; seeded |
| Export is not here | CSV/Excel is Phase 12 (POS-API) |

---

# Phase 10 — Digital receipts and devices

**Gate:** async receipt failures cannot damage the sale. **Passed 2026-09-27.**

```text
REQUIRED FEATURE IDS:   12 accounted (RCPT-002, -006..-009, PAY-012, -013, DEV-001..004, SELL-004)
DONE:                    7  (RCPT-002 -- unblocked, RCPT-009, DEV-001..004, SELL-004)
BUILDING:                2  (RCPT-006 WhatsApp -- needs the module key; PAY-012 -- QR done, auto-confirm needs a provider)
BLOCKED:                 3  (RCPT-007 SMS, RCPT-008 email, PAY-013 card terminal -- providers, decision #12)
TESTS:                 787 backend + 119 UI in real Chrome (incl. a real barcode through a fake camera), all passing
STATUS: COMPLETE for what can be built
```

## The gate, and how it is held

Sending a receipt is its own request, long after the bill committed, and writes only to
`receipt_sends`. `verify-receipts` sends through every failure -- not set up, no customer, the person
replied STOP, the service down -- and after each compares the whole bill, byte for byte, to what it
was. Selling carries on while WhatsApp is down (tested).

## One receipt, many copies

The PDF (download, WhatsApp, the public link) is drawn from one receipt DOCUMENT built from the
saved bill's own figures -- the same ones the paper prints. That is why POS-RCPT-002 waited for this
phase: two renderers that each did their own arithmetic is how a copy stops matching the paper. The
PDF is written by hand (built-in Courier, the QR drawn as squares): a few kB, readable everywhere,
checked by reading it back with pypdf.

## Found while building

| Found | Was |
|---|---|
| **All nine seed barcodes had wrong EAN-13 check digits** | No camera (or EAN-aware scanner) would read them off a label -- the seed was quietly unrealistic. Found when the barcode generator for the camera test refused to draw them. Corrected in the seed (the seed now updates barcodes on existing rows) |
| **The camera showed a black box in development** | React sets an effect up, tears it down and sets it up again; the first run's stop cleared the video the second run had just attached. The camera now starts a tick later and the start is cancelled on teardown. Found by the fake-camera test |
| **A test waited for "CREDIT NOTE" and matched "Opening the credit note..."** | Text matching ignores case; the check read the page too early. Now an exact match |
| **Prisma would not create a migration non-interactively** (a new unique column asks to confirm) | Generated with `prisma migrate diff` from the live schema, checked for any DROP of the hand-written constraints (none), applied with `migrate deploy` |

---

# Standing evidence

Tests that exist today and must keep passing. **Run one at a time** -- they share the local
database and the dev server restarts when `src/` changes.

| Suite | Checks | Covers |
|---|---:|---|
| `verify-money` | 47 | CORE-007; 1,45,716 GST splits at 5/12/18% |
| `verify-sale` | 49 | CORE-008, CORE-009, SELL-001..025 partial, PAY-001..004 |
| `verify-bills` | 27 | SALE-001..009, RCPT-003/004 |
| `verify-payments` | 48 | PAY-005..011 |
| `verify-variants` | 27 | SELL-006..008 |
| `verify-customers` | 55 | CUST-001..011, -014 |
| `verify-approvals` | 42 | APR-001..003, -006, CORE-010 |
| `verify-orders` | 63 | ORD-001..014, PAY-014, HOME-004 |
| `verify-held-bills` | 30 | SELL-020..022 |
| `verify-returns` | 130 | RET-001..007, EXC-001..005, APR-004/005, SALE-010..012, PAY-015/016, CUST-012/015 |
| `verify-shifts` | 69 | SHIFT-001..009, DAY-001..005, HOME-005 |
| `verify-events` | 42 | INV-003, -006..-008 (POS side): stock count, outbox |
| `verify-inventory-link` | 59 | INV-001, -009, SYNC-006 (POS side, against a stand-in). **Known race:** a dev server running its own delivery loop (DISABLE_BACKGROUND_JOBS unset) can pick up the suite's test shop mid-run and fail a timing check; rerun, or run the server with background jobs off |
| `verify-reports` | 41 | RPT-001..011 |
| `verify-receipts` | 61 | RCPT-002, -006, -009, PAY-012, DEV-001..004 |
| `verify-inventory-e2e` (needs a throwaway Inventory tenant) | 17 | Phase 8 against the REAL Inventory |
| frontend `scripts/verify-returns-ui.mjs` | 33 | WF-RETURN-01, WF-EXCHANGE-01 in real Chrome, three sizes |
| frontend `scripts/verify-shifts-ui.mjs` | 33 | WF-SHIFT-01, WF-CASH-01, WF-DAY-01 as cashier and manager, three sizes |
| frontend `scripts/verify-reports-ui.mjs` | 17 | WF-REPORTS-01 as cashier and manager, three sizes |
| frontend `scripts/verify-stock-ui.mjs` | 3 | pieces-left moves with a sale and a return |
| frontend `scripts/verify-phase10-ui.mjs` | 28 | receipt QR/PDF/WhatsApp, public receipt, UPI QR, devices, camera scan with a real barcode |
| frontend `scripts/verify-responsive.mjs` | 5 | CORE-001 live reflow |

```
node src/scripts/local-db.mjs start
npm run typecheck
npm run verify:money      (and each of the others, one at a time)
```
