# BUILD PLAN AND COVERAGE

Phase order is `MASTER.md` §10. Each phase must leave the product usable.

| Phase | Outcome | Status |
|---|---|---|
| 0 | Foundation + responsive shell | **COMPLETE** 2026-09-27 |
| 1 | Sell + cash + receipt + bill history | **COMPLETE**, except POS-RCPT-002 (BLOCKED, reason recorded) |
| 2 | UPI/card/split + payment safety | **COMPLETE** 2026-09-27 |
| 3 | Customer + CRM seam | **COMPLETE** for the customer; CRM half BLOCKED (CHG-007) |
| 4 | Discounts/overrides + approvals | PLANNED |
| 5 | Orders/keep/dues | PLANNED |
| 6 | Returns + exchange | PLANNED |
| 7 | Shift + cash movements + day close | PLANNED |
| 8 | Inventory seam + standalone | PLANNED |
| 9 | Operational reports | PLANNED |
| 10 | Digital receipts + devices | PLANNED |
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

# Standing evidence

Tests that exist today and must keep passing.

| Suite | Checks | Covers |
|---|---:|---|
| `verify-money` | 47 | CORE-007; 1,45,716 GST splits at 5/12/18% |
| `verify-sale` | 48 | CORE-008, CORE-009, SELL-001..025 partial, PAY-001..004 |

Run one at a time against the local Postgres:

```
node src/scripts/local-db.mjs start
npm run verify:money
npm run verify:sale
```
