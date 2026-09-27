# BUILD PLAN AND COVERAGE

Phase order is `MASTER.md` §10. Each phase must leave the product usable.

| Phase | Outcome | Status |
|---|---|---|
| 0 | Foundation + responsive shell | **COMPLETE** 2026-09-27 |
| 1 | Sell + cash + receipt + bill history | Partly built ahead of order (see note) |
| 2 | UPI/card/split + payment safety | PLANNED |
| 3 | Customer + CRM seam | PLANNED |
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
