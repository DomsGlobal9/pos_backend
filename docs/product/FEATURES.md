# FEATURE LEDGER

Every approved feature from `MASTER.md` §6. **IDs are permanent. Rows are never deleted.**

Status vocabulary: `PLANNED` · `BUILDING` · `BLOCKED` · `VERIFY` · `DONE` · `REMOVED` · `DEFERRED`

`DONE` requires the feature gate in `MASTER.md` §12 — including phone, tablet and desktop
behaviour and passing tests. A feature that works on one device is `BUILDING`, not `DONE`.

## Standing count

| | Count |
|---|---:|
| Approved feature IDs | 211 |
| DONE | 12 |
| BUILDING (works, gate not met) | 22 |
| BLOCKED (dependency named) | 2 |
| PLANNED | 175 |
| REMOVED without approval | **0** |
| Unaccounted | **0** |

Last reconciled: 2026-09-27, at Phase 0 close.

---

## 6.1 Foundation / shell

| ID | P | Feature | Phase | Status | Evidence / note |
|---|---|---|---|---|---|
| POS-CORE-001 | P0 | Responsive phone/tablet/desktop shell | 0 | **DONE** | `verify:responsive` — 5 sizes reflow live in real Chrome; a full sale completed at 375px |
| POS-CORE-002 | P0 | Gateway auth + tenant/module entitlement | 0 | BUILDING | `middleware/gateway.middleware.ts` written, audience `pos`, **not yet mounted** — `devActor` stands in |
| POS-CORE-003 | P0 | Local POS roles/permissions | 0 | BUILDING | `types/actor.ts` + User/Role/Permission models exist; nothing enforces them yet |
| POS-CORE-004 | P0 | Counter identity | 0 | BUILDING | `Counter` model + seed; no picker UI |
| POS-CORE-005 | P0 | Human connection/service health | 0 | **DONE** | In the shell header on all three sizes, in words not codes |
| POS-CORE-006 | P0 | Active basket crash/refresh recovery | 0 | **DONE** | QA-BASKET-02 and QA-BASKET-03 both pass |
| POS-CORE-007 | P0 | Integer-paise money everywhere | 0 | **DONE** | `services/money`, 47 checks incl. 1,45,716 GST splits |
| POS-CORE-008 | P0 | Server-authoritative invoice/credit-note series | 0 | **DONE** | `services/invoice-series`; 8 concurrent sales, no gaps |
| POS-CORE-009 | P0 | Idempotent writes/retries | 0 | **DONE** | `onceKey` unique; replay + race tested |
| POS-CORE-010 | P0 | Audit trail for sensitive actions | 4 | PLANNED | `AuditLog` model exists, nothing writes to it |

## 6.2 Home

| ID | P | Feature | Phase | Status | Evidence / note |
|---|---|---|---|---|---|
| POS-HOME-001 | P0 | New Sale CTA | 0 | **DONE** | 56px, full width, reachable on a 375px phone |
| POS-HOME-002 | P0 | Today sales total | 0 | **DONE** | `services/home`; local trading day, not UTC |
| POS-HOME-003 | P0 | Bill count | 0 | **DONE** | |
| POS-HOME-004 | P0 | Orders needing attention | 0 | **BLOCKED** | No Order data until Phase 5. Tile shows nothing rather than a fake zero |
| POS-HOME-005 | P0 | Shift status | 0 | **BLOCKED** | No Shift service until Phase 7 |
| POS-HOME-006 | P0 | Human sync/connection status | 0 | **DONE** | Shell header: "All saved" / "Saving is paused. Nothing you have entered is lost." |
| POS-HOME-007 | P0 | Recent activity feed | 0 | **DONE** | Sales only until returns and orders exist |

## 6.3 Sell / basket / pricing

| ID | P | Feature | Phase | Status | Evidence / note |
|---|---|---|---|---|---|
| POS-SELL-001 | P0 | Search by product name | 1 | BUILDING | `services/items`; every word must match |
| POS-SELL-002 | P0 | Search by SKU/item code | 1 | BUILDING | |
| POS-SELL-003 | P0 | Barcode scanner input | 1 | BUILDING | 150 ms contract — counter only, CHG-002 |
| POS-SELL-004 | P0 | Phone camera barcode scan | 10 | PLANNED | No 150 ms claim, CHG-002 |
| POS-SELL-005 | P0 | Exact barcode auto-add | 1 | BUILDING | Two exact matches offered as a choice |
| POS-SELL-006 | P0 | Product/variant picker | 1 | PLANNED | `WF-PRODUCT-01` not built |
| POS-SELL-007 | P0 | Product image where available | 1 | PLANNED | No image field on `Item` yet |
| POS-SELL-008 | P0 | Stock/last-one indication | 1 | BUILDING | "last one" / "none left"; null is not shown as zero |
| POS-SELL-009 | P0 | Add line to basket | 1 | BUILDING | |
| POS-SELL-010 | P0 | Change quantity | 1 | BUILDING | |
| POS-SELL-011 | P0 | Remove line | 1 | BUILDING | |
| POS-SELL-012 | P0 | Shelf price includes GST | 1 | BUILDING | `splitInclusiveTax`; tax is a subtraction |
| POS-SELL-013 | P0 | Shared automatic offers/pricing | 4 | PLANNED | Requires shared package — see CHANGELOG pending #4 |
| POS-SELL-014 | P0 | Show savings | 1 | BUILDING | `savedPaise` on sale + receipt |
| POS-SELL-015 | P0 | Manual discount within limit | 4 | PLANNED | `priceBasket` accepts it; no UI, no permission check |
| POS-SELL-016 | P0 | Discount above limit approval | 4 | PLANNED | |
| POS-SELL-017 | P0 | Price override approval | 4 | PLANNED | `SaleLine.priceOverrideReason` exists, unused |
| POS-SELL-018 | P0 | Add/select optional customer inline | 3 | PLANNED | |
| POS-SELL-019 | P0 | Park/hold active basket | 5 | PLANNED | `HeldBill` model exists |
| POS-SELL-020 | P0 | Recall parked basket | 5 | PLANNED | |
| POS-SELL-021 | P0 | Multiple parked baskets with labels | 5 | PLANNED | |
| POS-SELL-022 | P0 | Continue to payment | 1 | BUILDING | |
| POS-SELL-023 | P0 | Complete sale | 1 | BUILDING | One transaction; Inventory/CRM effects absent (Phases 8, 3) |
| POS-SELL-024 | P0 | Round-off as explicit line | 1 | BUILDING | `charged = lines + round-off` tested |
| POS-SELL-025 | P0 | Frozen historical pricing snapshot | 1 | BUILDING | Description/HSN/price/tax split copied onto the line |

## 6.4 Customers / CRM seam

| ID | P | Feature | Phase | Status | Evidence / note |
|---|---|---|---|---|---|
| POS-CUST-001 | P0 | Sale without customer | 1 | BUILDING | No code path requires a customer |
| POS-CUST-002 | P0 | Phone lookup | 3 | PLANNED | |
| POS-CUST-003 | P0 | Country code / foreign phone | 3 | PLANNED | |
| POS-CUST-004 | P0 | Quick customer create | 3 | PLANNED | |
| POS-CUST-005 | P0 | Name capture | 3 | PLANNED | |
| POS-CUST-006 | P0 | Explicit marketing consent | 3 | PLANNED | Only ever turned ON at the till, never off |
| POS-CUST-007 | P0 | Customer list/search | 3 | PLANNED | |
| POS-CUST-008 | P0 | Compact customer card | 3 | PLANNED | |
| POS-CUST-009 | P0 | Recent purchases | 3 | PLANNED | |
| POS-CUST-010 | P0 | Visit count / lifetime spend | 3 | PLANNED | |
| POS-CUST-011 | P0 | Outstanding balance | 5 | PLANNED | Needs Orders |
| POS-CUST-012 | P0 | Loyalty / store credit when enabled | 3 | PLANNED | **Always needs a live hold** — never spent from cache |
| POS-CUST-013 | P1 | View in CRM deep link | 3 | PLANNED | |
| POS-CUST-014 | P0 | Sale updates customer history automatically | 3 | PLANNED | |
| POS-CUST-015 | P0 | Return/exchange updates customer history | 6 | PLANNED | |

## 6.5 Payments

| ID | P | Feature | Phase | Status | Evidence / note |
|---|---|---|---|---|---|
| POS-PAY-001 | P0 | Cash payment | 1 | BUILDING | |
| POS-PAY-002 | P0 | Tendered cash | 1 | BUILDING | Stored as drawer evidence |
| POS-PAY-003 | P0 | Change due | 1 | BUILDING | Shown large |
| POS-PAY-004 | P0 | Exact cash shortcut | 1 | BUILDING | Plus next-note shortcuts |
| POS-PAY-005 | P0 | UPI manual / reference | 2 | PLANNED | Schema accepts it; no UI |
| POS-PAY-006 | P0 | Card manual / reference | 2 | PLANNED | |
| POS-PAY-007 | P0 | Split payment | 2 | PLANNED | Server already sums and refuses a mismatch |
| POS-PAY-008 | P0 | Multiple payment rows | 2 | BUILDING | Model supports it; UI sends one |
| POS-PAY-009 | P0 | Idempotent payment retry | 1 | BUILDING | `onceKey:pay:N` per row |
| POS-PAY-010 | P0 | Ambiguous / unknown provider state | 2 | PLANNED | **No `status` field on `Payment` yet — schema gap** |
| POS-PAY-011 | P0 | Check / reconcile payment status | 2 | PLANNED | `WF-PAY-02` |
| POS-PAY-012 | P1 | Dynamic UPI QR / provider | 10 | PLANNED | |
| POS-PAY-013 | P1 | Card terminal integration | 10 | PLANNED | |
| POS-PAY-014 | P0 | Collect later against kept order | 5 | PLANNED | `Payment.collectedAt` exists |
| POS-PAY-015 | P0 | Refund payment path | 6 | PLANNED | |
| POS-PAY-016 | P1 | Store credit refund / spend | 6 | PLANNED | |

## 6.6 Receipts

| ID | P | Feature | Phase | Status | Evidence / note |
|---|---|---|---|---|---|
| POS-RCPT-001 | P0 | 80 mm browser print | 1 | BUILDING | Print never gates the save |
| POS-RCPT-002 | P0 | PDF receipt | 1 | PLANNED | Browser print-to-PDF is not the same thing |
| POS-RCPT-003 | P0 | Reprint | 1 | PLANNED | `getSale` exists; no Bills screen to reach it |
| POS-RCPT-004 | P0 | Duplicate / reprint marking | 1 | PLANNED | **Schema gap** — no reprint count |
| POS-RCPT-005 | P0 | GST split / round-off / savings on receipt | 1 | BUILDING | Split read from stored line values, not recomputed |
| POS-RCPT-006 | P1 | WhatsApp receipt | 10 | PLANNED | WhatsApp service is deployed elsewhere |
| POS-RCPT-007 | P1 | SMS receipt | 10 | PLANNED | |
| POS-RCPT-008 | P1 | Email receipt | 10 | PLANNED | |
| POS-RCPT-009 | P1 | QR / digital receipt | 10 | PLANNED | |

## 6.7 Orders / keep for customer / dues

All PLANNED, Phase 5. `Sale.kind = KEPT` and `SaleStatus.BALANCE_DUE` exist; collection date,
notes and user-facing status are **schema gaps**.

| ID | P | Feature | ID | P | Feature |
|---|---|---|---|---|---|
| POS-ORD-001 | P0 | Keep for customer | POS-ORD-008 | P0 | Due status |
| POS-ORD-002 | P0 | Advance payment | POS-ORD-009 | P0 | Complete status |
| POS-ORD-003 | P0 | Balance due | POS-ORD-010 | P0 | Orders list / filter |
| POS-ORD-004 | P0 | Collection / promised date | POS-ORD-011 | P0 | Order detail |
| POS-ORD-005 | P0 | Order / bill notes | POS-ORD-012 | P0 | Collect partial / full balance |
| POS-ORD-006 | P0 | Waiting status | POS-ORD-013 | P0 | Warn before handover with due |
| POS-ORD-007 | P0 | Ready status | POS-ORD-014 | P0 | Hand over / complete |

## 6.8 Sales history

All PLANNED, Phase 1 (bill history is P0 per `MASTER.md` §16.5).

`POS-SALE-001` bill history · `-002` search by invoice · `-003` search by customer/phone ·
`-004` filter by date · `-005` filter by payment method · `-006` filter by status ·
`-007` bill detail · `-008` payment history · `-009` view customer · `-010` start return ·
`-011` start exchange · `-012` cancel/void policy (never delete history).

## 6.9 Returns / exchange

All PLANNED, Phase 6. `Return`, `ReturnLine`, credit-note series all exist in schema.

`POS-RET-001` return from bill · `-002` line + qty (never more than remaining) · `-003` reason ·
`-004` return window · `-005` outside-window approval · `-006` credit note numbering ·
`-007` refund path · `-008` updates Inventory · `-009` updates CRM.
`POS-EXC-001` exchange from bill · `-002` replacement variant · `-003` reprice ·
`-004` difference only · `-005` credit note linked to new sale · `-006` updates both seams.

## 6.10 Manager approval / permissions

All PLANNED, Phase 4. **Schema gap** — no approval record (requester, approver, reason).

`POS-APR-001` in-place approval, no cashier logout · `-002` exceptional discount ·
`-003` price override · `-004` cashier return/refund · `-005` outside-window return ·
`-006` permission-denied human state.

## 6.11 Shift / drawer / day close

All PLANNED, Phase 7. `Shift` and `DayClose` exist; **cash in/out has no model — schema gap**.

`POS-SHIFT-001` open shift · `-002` cashier/counter per sale (partly present: `Sale.cashierId`) ·
`-003` cash in · `-004` cash out · `-005` expected cash · `-006` counted cash ·
`-007` variance never silently corrected · `-008` close shift · `-009` overnight warning.
`POS-DAY-001` totals by method · `-002` returns/discounts · `-003` cash position ·
`-004` pending sync count · `-005` closed day immutable.

## 6.12 Inventory seam / standalone

| ID | P | Feature | Phase | Status | Note |
|---|---|---|---|---|---|
| POS-INV-001 | P0 | Catalogue read/cache | 8 | PLANNED | `Item.inventoryVariantId`, `cachedQty` ready |
| POS-INV-002 | P0 | Variant/barcode/price/tax mapping | 8 | PLANNED | |
| POS-INV-003 | P0 | Stock availability display | 8 | BUILDING | Reads own cache today |
| POS-INV-004 | P0 | Limited-stock hold/reserve | 8 | PLANNED | `Sale.holdId` column ready |
| POS-INV-005 | P0 | Hold confirm/release | 8 | PLANNED | `Sale.holdConfirmedAt` ready |
| POS-INV-006 | P0 | Completed sale stock event | 8 | PLANNED | |
| POS-INV-007 | P0 | Return stock event | 8 | PLANNED | |
| POS-INV-008 | P0 | Exchange stock effects | 8 | PLANNED | |
| POS-INV-009 | P0 | Safe degradation when Inventory down | 8 | PLANNED | Never freeze the sell screen |
| POS-STAND-001 | P0 | Standalone own item list | 1 | BUILDING | `Item` table is master today |
| POS-STAND-002 | P0 | Import catalogue from Inventory/CSV | 12 | PLANNED | |
| POS-STAND-003 | P0 | Standalone pricing works | 1 | BUILDING | `services/basket` is pure, no Inventory needed |

## 6.13 CRM seam

All PLANNED, Phase 3. New since CHG-003; nothing exists.

`POS-CRM-001` lookup · `-002` create/update · `-003` sale event · `-004` return/exchange event ·
`-005` dues/payment change · `-006` consent sync · `-007` CRM-unavailable safe UX.

## 6.14 Sync / offline stage 1

All PLANNED, Phase 11, except:

| ID | P | Feature | Phase | Status | Note |
|---|---|---|---|---|---|
| POS-SYNC-001 | P0 | Online state | 0 | **DONE** | Shell header, every screen |
| POS-SYNC-002 | P0 | Unstable connection state | 0 | **DONE** | Says the work is safe; never shows a status code |
| POS-SYNC-003 | P0 | Waiting-to-sync state | 11 | PLANNED | |
| POS-SYNC-004 | P0 | Pending count / list | 11 | PLANNED | `WF-SYNC-01` |
| POS-SYNC-005 | P0 | Idempotent retry / outbox | 11 | PLANNED | Server half already safe |
| POS-SYNC-006 | P0 | Pending hold reconciliation | 11 | PLANNED | Never show the word "hold" to a cashier |
| POS-OFF-001 | P0 | Basket survives line blink | 0 | **DONE** | Basket and once-key saved together |
| POS-OFF-002 | P0 | Stage-1 retry of completed work | 11 | PLANNED | |
| POS-OFF-003 | P2 | Full offline billing | — | DEFERRED | Approved deferral, `MASTER.md` §16.9 |

## 6.15 Reports

All PLANNED, Phase 9.
`POS-RPT-001` today sales · `-002` by payment method · `-003` by cashier · `-004` by counter ·
`-005` returns/exchanges · `-006` discounts/overrides · `-007` tax summary · `-008` cash variance ·
`-009` outstanding dues · `-010` day close · `-011` top sellers (P1).

## 6.16 Settings / devices

| ID | P | Feature | Phase | Status | Note |
|---|---|---|---|---|---|
| POS-SET-001 | P0 | Business name/GSTIN/address/logo | 0 | BUILDING | Stored + on receipt; no editor UI |
| POS-SET-002 | P0 | Invoice format / FY / rounding | 0 | BUILDING | `invoicePrefix` used; rounding fixed at NEAREST_RUPEE |
| POS-SET-003 | P0 | Payment methods enabled | 2 | BUILDING | Column exists, not enforced |
| POS-SET-004 | P0 | Receipt footer / print setup | 1 | BUILDING | Footer prints |
| POS-SET-005 | P0 | Discount limits | 4 | BUILDING | Column exists, not enforced |
| POS-SET-006 | P0 | Return window / rules | 6 | BUILDING | Column exists, not enforced |
| POS-SET-007 | P0 | Hold threshold | 8 | BUILDING | Column exists, default 3, not enforced |
| POS-SET-008 | P0 | Role-gated settings | 4 | PLANNED | |
| POS-DEV-001..004 | P1 | Counter/printer/scanner/health | 10 | PLANNED | |

## 6.17 External integrations

All PLANNED, Phase 12. Webhook models already ported from Inventory's Storefront tables, so
`POS-WEB-002/003/004/005` have their schema in place.

`POS-API-001..007` REST · `POS-WEB-001..006` signed webhooks · `POS-EXP-001/002` CSV/Excel.

## 6.18 Compliance

| ID | P | Feature | Phase | Status | Note |
|---|---|---|---|---|---|
| POS-COMP-001 | P0 | IRN / ackNo / signedQR fields preserved | 0 | **DONE** | Nullable on `Sale` from the first migration |
| POS-COMP-002 | P2 | E-invoicing workflow | — | DEFERRED | Above ₹5 crore turnover only |
