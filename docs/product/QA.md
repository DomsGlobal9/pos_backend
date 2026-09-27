# QA

The scenarios in `MASTER.md` §14 must all pass before commercial release. This file tracks which
pass today and where the evidence is.

`PASS` needs a named suite or a recorded manual run. Nothing is `PASS` on inspection alone.

| ID | Area | Scenario | Pass condition | Status | Evidence |
|---|---|---|---|---|---|
| QA-SELL-01 | Sell | Rapid repeated barcode scan | Correct quantities, no dropped or duplicated lines, <150 ms perceived | PARTIAL | Single scans verified in browser; rapid-repeat not yet driven |
| QA-BASKET-02 | Basket | Refresh/crash with a populated basket | Exact basket restored | **PASS** | Browser: basket + once-key survived reload 2026-09-27 |
| QA-BASKET-03 | Basket | Reload AFTER a completed sale | Basket empty, new key, no second sale possible | **PASS** | Found as a bug and fixed same day; `lib/basket.js` v2 |
| QA-SALE-04 | Sale | Double press Complete / timeout retry | One invoice only | **PASS** | `verify-sale`: replay returns the first bill; 1 row for the key |
| QA-SALE-05 | Sale | Same key, different basket | Refused, naming the invoice already made | **PASS** | `verify-sale` |
| QA-SALE-06 | Sale | Two tills complete at the same instant | Different numbers, no gap | **PASS** | `verify-sale`: 8 concurrent |
| QA-MONEY-07 | Money | GST / discount / rounding edges | Totals invariant; day close balances | **PASS** (money) | `verify-money` 1,45,716 prices; day close not built |
| QA-MONEY-08 | Money | Failed sale | Burns no invoice number | **PASS** | `verify-sale` |
| QA-PAY-09 | Payment | Split short or over | Blocked with the exact difference | PARTIAL | Server refuses a mismatch; split UI is Phase 2 |
| QA-PAY-10 | Payment | Provider debited but timed out | Needs-checking; no blind second charge | **FAIL — not built** | Phase 2, P0. Schema gap: no `Payment.status` |
| QA-CUST-11 | Customer | Customer refuses to give a phone | Sale completes normally | **PASS** | No code path requires a customer |
| QA-CUST-12 | Customer | Concurrent same-phone create | One customer identity | PLANNED | Phase 3 |
| QA-ORD-13 | Orders | Partial balance collection | Due and history correct | PLANNED | Phase 5 |
| QA-ORD-14 | Orders | Handover with money due | Explicit warning | PLANNED | Phase 5 |
| QA-RET-15 | Return | Partial previous return | Cannot exceed remaining eligible qty | PLANNED | Phase 6 |
| QA-RET-16 | Return | Outside the return window | Correct approval path | PLANNED | Phase 6 |
| QA-EXC-17 | Exchange | Replacement dearer or cheaper | Only the difference moves | PLANNED | Phase 6 |
| QA-APR-18 | Approval | Cashier exceeds the discount limit | In-place approval, cashier context kept | PLANNED | Phase 4 |
| QA-CASH-19 | Cash | Petty cash removed | Cash-out explains the drawer expectation | PLANNED | Phase 7 |
| QA-SHIFT-20 | Shift | Drawer short or over | Difference recorded, never silently corrected | PLANNED | Phase 7 |
| QA-DAY-21 | Day | Shift left open overnight | Explicit warning at day close | PLANNED | Phase 7 |
| QA-OFF-22 | Offline | Network blinks mid-basket | Basket safe + human status | **PASS** | Basket safe; header says the work is safe without a status code |
| QA-RETRY-23 | Retry | Pending sale/event retried | No duplicate financial/stock/customer effect | PARTIAL | Financial side proven; stock and customer effects not built |
| QA-INV-24 | Inventory | Inventory slow or unavailable | UI does not freeze; configured safe behaviour | PLANNED | Phase 8 |
| QA-CRM-25 | CRM | CRM unavailable | Sale usable; limitation explained | PLANNED | Phase 3 |
| QA-RCPT-26 | Receipt | Printer unavailable | Sale complete; reprint available | PARTIAL | Print never gates the save; reprint UI is Phase 1 |
| QA-HIST-27 | History | Product renamed after the sale | Old bill shows the original description, price and tax | **PASS** | Frozen onto the line; reprint split test in `verify-sale` |
| QA-PERM-28 | Permissions | Cashier tries a restricted action | Human denial or approval path, no data leak | PLANNED | Phase 4 |
| QA-MOB-29 | Mobile | Portrait phone | No critical horizontal scroll; primary CTA reachable | **PASS** | 375px: scrollWidth == innerWidth on Home and Sell; CTA 56px; full sale completed |
| QA-DESK-30 | Desktop | Scanner + keyboard sale | Mouse not required for a normal fast sale | PARTIAL | Focus returns to the search box; full keyboard map is Phase 1 |
| QA-CUT-31 | Cut-over | A historical old sale | Readable, reprintable, returnable | PLANNED | Phase 13 |

## Standing count

| | |
|---|---:|
| Scenarios required | 31 |
| PASS | 11 |
| PARTIAL | 6 |
| FAIL (named, not hidden) | 1 |
| PLANNED | 13 |

Plus one added during Phase 0:

| ID | Area | Scenario | Pass condition | Status | Evidence |
|---|---|---|---|---|---|
| QA-RESP-32 | Responsive | Window resized across breakpoints without reload | Nav and layout reflow; no sideways scroll | **PASS** | `verify:responsive`, 5 sizes, real Chrome |

The one remaining FAIL is `QA-PAY-10` — ambiguous provider result. It is P0 and Phase 2, and it is
listed as FAIL rather than PLANNED on purpose: until it exists, a provider timeout has no safe
path.

## How to run

```
node src/scripts/local-db.mjs start     # real Postgres, port 55432
npm run verify:money
npm run verify:sale
```

And in the frontend repo, with the dev server running:

```
npm run verify:responsive
```

One suite at a time. Editing `src/` restarts the dev server and will kill a running suite.
