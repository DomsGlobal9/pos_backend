# ScaleEzy POS — Build-Ready Master Specification

**Version:** 2.0 — Build Ready  
**Status:** AUTHORITATIVE EXECUTION BASELINE  
**Purpose:** Build ScaleEzy POS with AI agents without silently losing approved features, screen links, cross-module effects, responsive behaviour, permissions, edge cases, or tests.

> **North Star:** Open → Scan/Search → Pay → Done.
>
> **Class 7 Rule:** A first-time user should be able to complete a normal sale in under 60 seconds without training.
>
> **Engineering Rule:** Complexity belongs in the system, never on the screen.

---

# 0. How to Use This File

This file is the starting authority for the POS build. Do **not** tell an AI agent “build the POS” and allow it to improvise.

For every build request the agent must:

1. Read this file completely.
2. Read the current repository product docs and changelog if they exist.
3. Inspect the relevant code read-only.
4. Run a preflight and reconcile requirements against code.
5. Build one complete vertical slice.
6. Run the coverage gates in this file.
7. Re-read the original requirement after implementation.
8. Mark work complete only when every required feature is accounted for.

**The agent may discover more work. It may not silently discover less work.**

## Absolute anti-loss rule

Every approved item must end in exactly one state:

- `DONE` — implemented and verified.
- `BLOCKED` — cannot be completed; reason and dependency recorded.
- `DEFERRED` — explicitly approved for later.
- `REMOVED` — explicitly approved removal with impact recorded.

There is no silent omission state.

---

# 1. Product Brief

ScaleEzy POS is a **mobile-first, touch-first and scanner-fast retail selling experience** connected invisibly to ScaleEzy Inventory and CRM.

It must work beautifully on:

- Phone — camera scan, one-hand operation, bottom navigation.
- Tablet — touch-first, more context visible.
- Desktop/counter — barcode scanner + keyboard-first high-speed selling.

The same business rules and transaction engine power all three.

## Personas

| Persona | Primary job | Keep their experience focused on |
|---|---|---|
| Cashier / salesperson | Sell quickly | Sell, Orders, Customers, Shift |
| Manager | Resolve exceptions | Approvals, returns, discounts, shift issues |
| Owner | Know what happened | Home, sales, dues, day close, simple reports |
| Accountant | Reconcile | Tax/payment/day-close summaries and exports |
| Integrator | Connect systems | API, webhooks, imports/exports |

## UX commandments

1. Maximum five primary mobile destinations.
2. One obvious primary CTA per screen.
3. No critical horizontal scrolling on phone.
4. Plain language only.
5. Never expose `outbox`, `idempotency`, `holdId`, `Gateway`, raw webhook status, stack traces, or internal UUIDs to store users.
6. Automate safe decisions.
7. Never lose an active basket because of refresh, crash or temporary connection loss.
8. Never require a customer record to complete an ordinary sale.
9. Never make a cashier manage Inventory or CRM integration.
10. Never make mobile simplicity slow down a desktop cashier.

---

# 2. Keep Documentation Simple

Use this structure. Do not create a documentation maze.

```text
docs/product/
├── MASTER.md          # this product/architecture baseline
├── FEATURES.md        # feature ledger and statuses
├── FLOWS.md           # user journeys + screen links
├── CONTRACTS.md       # module/API/event/permission contracts
├── BUILD.md           # current execution plan + coverage report
├── QA.md              # acceptance tests
├── CHANGELOG.md       # approved changes/removals
└── modules/           # one short execution brief per active module
```

**Rule:** If information fits one of these files, do not invent another product document.

## Authority order

When sources conflict:

1. Latest explicitly approved entry in `CHANGELOG.md`.
2. `MASTER.md`.
3. `FEATURES.md`.
4. `FLOWS.md`.
5. `CONTRACTS.md`.
6. Existing code.

Existing code is evidence of implementation, **not proof of the complete requirement**.

---

# 3. Product Architecture

```text
                         SCALEEZY

              PHONE | TABLET | COUNTER/DESKTOP
                         |
                         v
                    POS EXPERIENCE
          Home | Sell | Orders | Customers | More
                         |
                         v
                      POS DOMAIN
  Basket | Pricing | Sale | Payment | Order | Return | Shift | Receipt
                         |
          +--------------+--------------+
          |              |              |
          v              v              v
      INVENTORY          CRM         PAYMENTS
          |              |              |
          +--------------+--------------+
                         |
                       GATEWAY
                         |
          REST API | WEBHOOKS | CSV/EXCEL
```

## Ownership

### POS owns

- Active basket and parked basket.
- Sale/invoice transaction.
- Sale-line historical snapshot.
- POS payment record and collection against dues.
- Receipt/reprint record.
- Return/exchange transaction and credit-note linkage.
- Keep-for-customer/order transaction.
- Shift, drawer movements and day close.
- POS audit trail.

### Inventory owns

- Product and variant master.
- Barcode/SKU/item code.
- Authoritative stock.
- Stock movement.
- Supplier/procurement processes.
- Cost price.
- Stock reservations/holds when Inventory is enabled.

### CRM owns

- Customer relationship/profile depth.
- Customer communication history.
- Segmentation and lifecycle.
- Marketing activity.
- Customer-level relationship intelligence.

### Gateway owns

- Authentication.
- Tenant/module entitlement.
- Secure module access/routing.
- Integration authorization boundaries.

### Hard boundaries

- POS never writes directly to Inventory or CRM databases.
- A service function must not assume a logged-in browser user; actor/identity is explicit.
- Public integration contracts use public identities, not internal UUIDs.
- Shared pricing rules must not fork into POS-specific copies.

---

# 4. Navigation and Screen Registry

## Primary mobile navigation

```text
HOME | SELL | ORDERS | CUSTOMERS | MORE
```

Do not add another primary tab without explicit product approval.

## Canonical screen IDs

| Screen ID | Screen | Primary purpose | Main destinations |
|---|---|---|---|
| `WF-HOME-01` | Home | What matters now | Sell, order detail, More |
| `WF-SELL-01` | Sell | Build basket | Customer, approval, payment, held bills |
| `WF-PRODUCT-01` | Product/variant sheet | Pick variant | Back to Sell |
| `WF-CUST-01` | Customer quick sheet | Find/add/select customer | Back to Sell / customer detail |
| `WF-PAY-01` | Payment | Collect money | Success / payment check |
| `WF-PAY-02` | Payment needs checking | Resolve ambiguous provider state | Retry status / safe exit |
| `WF-SUCCESS-01` | Sale success | Receipt/new sale | Print/send/new sale/bill detail |
| `WF-ORDERS-01` | Orders | Waiting/Ready/Due/Complete | Order detail |
| `WF-ORDER-02` | Order detail | Collect/ready/handover | Payment / Orders |
| `WF-SALES-01` | Sales/Bills | Find transaction | Bill detail |
| `WF-SALE-02` | Bill detail | Act on historical bill | Receipt/return/exchange |
| `WF-RETURN-01` | Return | Return selected lines | Refund/credit note/success |
| `WF-EXCHANGE-01` | Exchange | Replace item | Difference payment/refund/success |
| `WF-HELD-01` | Held bills | Recall parked basket | Sell |
| `WF-CUSTOMERS-01` | Customers | Find customer | Customer detail |
| `WF-CUSTOMER-02` | Customer detail | Selling context | Sale/history/CRM deep link |
| `WF-SHIFT-01` | Shift | Open/current/close | Cash movement/day close |
| `WF-CASH-01` | Cash movement | Cash in/out | Shift |
| `WF-DAY-01` | Day close | Reconcile day | Home/reports |
| `WF-REPORTS-01` | Reports | Operational summaries | Report detail/export |
| `WF-MORE-01` | More | Secondary destinations | Sales/Shift/Reports/Settings/Sync |
| `WF-SYNC-01` | Sync status | Human-readable pending/problem status | Pending item detail |
| `WF-SETTINGS-01` | Settings | Owner/admin setup | Settings groups |
| `WF-DEVICES-01` | Counters/devices | Device setup/health | Device detail |
| `WF-INTEGRATIONS-01` | Integrations | Owner/integrator setup | API/webhook/import-export |

## Link integrity rule

Every interactive action must be one of:

- navigation to a registered screen,
- registered modal/sheet,
- registered external/deep link,
- registered system action (print, camera, share), or
- disabled with a visible reason.

**No dead buttons. No orphan screens. No unregistered destination.**

---

# 5. Canonical User Flows

## 5.1 Normal sale

```text
WF-HOME-01
  -> New Sale
WF-SELL-01
  -> scan/search -> product/variant -> basket
  -> optional customer -> WF-CUST-01 -> back
  -> optional discount -> manager approval if needed -> back
  -> Continue
WF-PAY-01
  -> Cash / UPI / Card / Split
  -> successful completion
WF-SUCCESS-01
  -> Print | Send Receipt | Bill Detail | New Sale
```

## 5.2 Park/recall

```text
WF-SELL-01 -> Hold/Park -> label -> WF-HELD-01
WF-HELD-01 -> Recall -> WF-SELL-01 with exact basket restored
```

## 5.3 Keep for customer / dues

```text
WF-SELL-01 -> Keep for Customer
  -> customer required for this workflow
  -> advance optional
  -> collection date/notes
  -> order created
WF-ORDERS-01 -> WF-ORDER-02
  -> Collect Balance -> WF-PAY-01 -> back
  -> Mark Ready
  -> Hand Over -> warn if due remains -> Complete
```

## 5.4 Return

```text
WF-SALES-01 -> WF-SALE-02 -> Return
WF-RETURN-01
  -> select eligible line/qty
  -> reason
  -> approval if required
  -> refund method / store credit if enabled
  -> credit note
  -> success -> updated bill detail
```

## 5.5 Exchange

```text
WF-SALE-02 -> Exchange
WF-EXCHANGE-01
  -> select return line/qty
  -> select replacement item/variant
  -> reprice
  -> collect/refund difference only
  -> credit note + linked new sale
  -> success
```

## 5.6 Shift/day close

```text
WF-SHIFT-01 -> Open Shift -> opening cash
  -> selling activity
  -> Cash In/Out -> WF-CASH-01
  -> Close Shift -> expected vs counted -> variance
WF-DAY-01 -> payment totals + returns + discounts + cash + pending sync -> Close Day
```

## 5.7 Complete-sale cross-module effects

```text
COMPLETE SALE
  POS        -> invoice + frozen lines + payment + receipt
  INVENTORY  -> confirm/release hold if applicable + stock movement
  CRM        -> purchase history + spend/visit/dues effects
  SHIFT      -> payment/cash totals
  REPORTS    -> operational aggregates
  AUDIT      -> sensitive action facts
  WEBHOOK    -> sale.completed for subscribed external systems
```

A complete-sale implementation is incomplete if any **applicable** effect above is absent or unaccounted for.

---

# 6. Complete Feature Registry — Initial Baseline

Copy these rows into `FEATURES.md`. IDs are permanent. Do not renumber.

## 6.1 Foundation / shell

| ID | P | Feature | Screen | Integrations / effect |
|---|---|---|---|---|
| POS-CORE-001 | P0 | Responsive phone/tablet/desktop shell | All | Same domain/API rules |
| POS-CORE-002 | P0 | Gateway authentication + tenant/module entitlement | All | Gateway |
| POS-CORE-003 | P0 | Local POS roles/permissions | All | Gateway identity + POS RBAC |
| POS-CORE-004 | P0 | Counter identity | Shift/Sell | Shop/counter |
| POS-CORE-005 | P0 | Human connection/service health | Home/More | POS/DB/modules |
| POS-CORE-006 | P0 | Active basket crash/refresh recovery | Sell | Local persistence + server rules |
| POS-CORE-007 | P0 | Integer-paise money everywhere | Domain | All financial features |
| POS-CORE-008 | P0 | Server-authoritative invoice/credit-note series | Domain | Sale/return |
| POS-CORE-009 | P0 | Idempotent writes/retries | Domain | Sale/payment/integration |
| POS-CORE-010 | P0 | Audit trail for sensitive actions | More/admin | All sensitive features |

## 6.2 Home

| ID | P | Feature | Screen | Effect |
|---|---|---|---|---|
| POS-HOME-001 | P0 | New Sale CTA | WF-HOME-01 | -> WF-SELL-01 |
| POS-HOME-002 | P0 | Today sales total | WF-HOME-01 | POS reports |
| POS-HOME-003 | P0 | Bill count | WF-HOME-01 | POS reports |
| POS-HOME-004 | P0 | Orders needing attention | WF-HOME-01 | Orders |
| POS-HOME-005 | P0 | Shift status | WF-HOME-01 | Shift |
| POS-HOME-006 | P0 | Human sync/connection status | WF-HOME-01 | Sync/integrations |
| POS-HOME-007 | P0 | Recent activity feed | WF-HOME-01 | POS activity |

## 6.3 Sell / basket / pricing

| ID | P | Feature | Screen | Integration / rule |
|---|---|---|---|---|
| POS-SELL-001 | P0 | Search by product name | WF-SELL-01 | Inventory/standalone catalogue |
| POS-SELL-002 | P0 | Search by SKU/item code | WF-SELL-01 | Inventory/standalone catalogue |
| POS-SELL-003 | P0 | Barcode scanner input | WF-SELL-01 | <150ms target |
| POS-SELL-004 | P0 | Phone camera barcode scan | WF-SELL-01 | Mobile |
| POS-SELL-005 | P0 | Exact barcode auto-add | WF-SELL-01 | Catalogue |
| POS-SELL-006 | P0 | Product/variant picker | WF-PRODUCT-01 | Inventory variants |
| POS-SELL-007 | P0 | Product image where available | Sell/product | Catalogue |
| POS-SELL-008 | P0 | Stock/last-one indication | Sell/product | Inventory |
| POS-SELL-009 | P0 | Add line to basket | WF-SELL-01 | Pricing |
| POS-SELL-010 | P0 | Change quantity | WF-SELL-01 | Reprice |
| POS-SELL-011 | P0 | Remove line | WF-SELL-01 | Reprice |
| POS-SELL-012 | P0 | Shelf price includes GST | WF-SELL-01 | Tax/money |
| POS-SELL-013 | P0 | Shared automatic offers/pricing | WF-SELL-01 | Shared pricing package |
| POS-SELL-014 | P0 | Show savings | Sell/receipt | Pricing |
| POS-SELL-015 | P0 | Manual discount within limit | WF-SELL-01 | Permission/audit |
| POS-SELL-016 | P0 | Discount above limit approval | Sell | Manager approval/audit |
| POS-SELL-017 | P0 | Price override approval | Sell | Manager approval/audit |
| POS-SELL-018 | P0 | Add/select optional customer inline | Sell | CRM/customer |
| POS-SELL-019 | P0 | Park/hold active basket | Sell | Held bill |
| POS-SELL-020 | P0 | Recall parked basket | Held/Sell | Exact restoration |
| POS-SELL-021 | P0 | Multiple parked baskets with labels | WF-HELD-01 | Shift visibility |
| POS-SELL-022 | P0 | Continue to payment | Sell | -> WF-PAY-01 |
| POS-SELL-023 | P0 | Complete sale | Payment/success | All cross-module effects |
| POS-SELL-024 | P0 | Round-off as explicit line | Payment/receipt | Money/daybook |
| POS-SELL-025 | P0 | Frozen historical pricing/offer snapshot | Domain | Historical accuracy |

## 6.4 Customers / CRM seam

| ID | P | Feature | Screen | Integration / rule |
|---|---|---|---|---|
| POS-CUST-001 | P0 | Sale without customer | Sell | Must remain possible |
| POS-CUST-002 | P0 | Phone lookup | WF-CUST-01 | CRM/local fallback |
| POS-CUST-003 | P0 | Country code/foreign phone support | Customer | Customer identity |
| POS-CUST-004 | P0 | Quick customer create | WF-CUST-01 | CRM/local fallback |
| POS-CUST-005 | P0 | Name capture | Customer | CRM |
| POS-CUST-006 | P0 | Explicit marketing consent | Customer | CRM |
| POS-CUST-007 | P0 | Customer list/search | WF-CUSTOMERS-01 | CRM |
| POS-CUST-008 | P0 | Compact customer card | Customer detail | CRM |
| POS-CUST-009 | P0 | Recent purchases | Customer detail | CRM/POS sales |
| POS-CUST-010 | P0 | Visit count/lifetime spend | Customer detail | CRM |
| POS-CUST-011 | P0 | Outstanding balance | Customer detail | Orders/CRM |
| POS-CUST-012 | P0 | Loyalty/store credit balance when enabled | Customer detail/payment | CRM/loyalty |
| POS-CUST-013 | P1 | View in CRM deep link | Customer detail | CRM |
| POS-CUST-014 | P0 | Completed sale updates customer history automatically | Background | CRM event |
| POS-CUST-015 | P0 | Return/exchange updates customer history automatically | Background | CRM event |

## 6.5 Payments

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-PAY-001 | P0 | Cash payment | WF-PAY-01 | Payment ledger |
| POS-PAY-002 | P0 | Tendered cash | WF-PAY-01 | Drawer evidence |
| POS-PAY-003 | P0 | Change due | WF-PAY-01 | Money |
| POS-PAY-004 | P0 | Exact cash shortcut | WF-PAY-01 | UX |
| POS-PAY-005 | P0 | UPI manual/reference | WF-PAY-01 | Provider-ready |
| POS-PAY-006 | P0 | Card manual/reference | WF-PAY-01 | Terminal-ready |
| POS-PAY-007 | P0 | Split payment | WF-PAY-01 | Sum must equal charged amount |
| POS-PAY-008 | P0 | Multiple payment rows | Domain | Historical/reconciliation |
| POS-PAY-009 | P0 | Idempotent payment retry | Domain | No duplicate collection record |
| POS-PAY-010 | P0 | Ambiguous/unknown provider state | WF-PAY-02 | Never blindly re-charge |
| POS-PAY-011 | P0 | Check/reconcile payment status | WF-PAY-02 | Provider when integrated |
| POS-PAY-012 | P1 | Dynamic UPI QR/provider integration | Payment | Optional provider |
| POS-PAY-013 | P1 | Card terminal integration | Payment | Optional provider |
| POS-PAY-014 | P0 | Collect later payment against kept order | Order/payment | collectedAt/history |
| POS-PAY-015 | P0 | Refund payment path | Return | Original/allowed method rules |
| POS-PAY-016 | P1 | Store credit refund/spend when enabled | Return/payment | CRM/credit |

## 6.6 Receipts

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-RCPT-001 | P0 | 80mm browser print | Success/bill | Printing never controls sale save |
| POS-RCPT-002 | P0 | PDF receipt | Bill | Historical |
| POS-RCPT-003 | P0 | Reprint | Bill | Auditable |
| POS-RCPT-004 | P0 | Duplicate/reprint marking | Receipt | Prevent confusion |
| POS-RCPT-005 | P0 | Receipt shows GST split/round-off/savings | Receipt | Money/tax |
| POS-RCPT-006 | P1 | WhatsApp receipt | Success/bill | Async |
| POS-RCPT-007 | P1 | SMS receipt | Success/bill | Async |
| POS-RCPT-008 | P1 | Email receipt | Success/bill | Async |
| POS-RCPT-009 | P1 | QR/digital receipt path | Success/bill | Async |

## 6.7 Orders / keep for customer / dues

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-ORD-001 | P0 | Keep for customer | Sell/order | Customer required here |
| POS-ORD-002 | P0 | Advance payment | Order/payment | Payment history |
| POS-ORD-003 | P0 | Balance due | Order | Derived accurately |
| POS-ORD-004 | P0 | Collection/promised date | Order | UX |
| POS-ORD-005 | P0 | Order/bill notes | Order | Human context |
| POS-ORD-006 | P0 | Waiting status | Orders | User-facing |
| POS-ORD-007 | P0 | Ready status | Orders | User-facing |
| POS-ORD-008 | P0 | Due status | Orders | User-facing |
| POS-ORD-009 | P0 | Complete status | Orders | User-facing |
| POS-ORD-010 | P0 | Orders list/filter | WF-ORDERS-01 | Simple tabs |
| POS-ORD-011 | P0 | Order detail | WF-ORDER-02 | Actions |
| POS-ORD-012 | P0 | Collect partial/full balance | Order/payment | Payment + CRM |
| POS-ORD-013 | P0 | Warn before handover with money due | Order | Explicit confirmation |
| POS-ORD-014 | P0 | Hand over/complete | Order | Audit/status |

## 6.8 Sales history

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-SALE-001 | P0 | Bill history | WF-SALES-01 | Historical source |
| POS-SALE-002 | P0 | Search by invoice number | Sales | Fast exact lookup |
| POS-SALE-003 | P0 | Search by customer/phone | Sales | Customer |
| POS-SALE-004 | P0 | Filter by date | Sales | UX |
| POS-SALE-005 | P0 | Filter by payment method | Sales | UX |
| POS-SALE-006 | P0 | Filter by status | Sales | Complete/due/returned/pending etc. |
| POS-SALE-007 | P0 | Bill detail | WF-SALE-02 | Frozen history |
| POS-SALE-008 | P0 | View payment history | Bill | Payments |
| POS-SALE-009 | P0 | View customer | Bill | CRM/customer |
| POS-SALE-010 | P0 | Start return from bill | Bill | Return |
| POS-SALE-011 | P0 | Start exchange from bill | Bill | Exchange |
| POS-SALE-012 | P0 | Cancel/void/correction policy | Bill/admin | Never delete history |

## 6.9 Returns / exchange

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-RET-001 | P0 | Return from original bill | WF-RETURN-01 | Eligibility |
| POS-RET-002 | P0 | Select line + quantity | Return | Cannot exceed remaining eligible qty |
| POS-RET-003 | P0 | Return reason | Return | Audit/reporting |
| POS-RET-004 | P0 | Return window rule | Return | Settings |
| POS-RET-005 | P0 | Outside-window manager approval | Return | Audit |
| POS-RET-006 | P0 | Credit note numbering | Return | Separate series |
| POS-RET-007 | P0 | Refund path | Return | Payment rules |
| POS-RET-008 | P0 | Return updates Inventory | Background | Stock authority |
| POS-RET-009 | P0 | Return updates CRM | Background | Customer history |
| POS-EXC-001 | P0 | Exchange from original bill | WF-EXCHANGE-01 | Return + new sale linkage |
| POS-EXC-002 | P0 | Select replacement product/variant | Exchange | Inventory/catalogue |
| POS-EXC-003 | P0 | Reprice replacement | Exchange | Shared pricing |
| POS-EXC-004 | P0 | Collect/refund difference only | Exchange/payment | Money |
| POS-EXC-005 | P0 | Link credit note to new sale | Domain | Historical trace |
| POS-EXC-006 | P0 | Exchange updates Inventory + CRM | Background | Both seams |

## 6.10 Manager approval / permissions

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-APR-001 | P0 | In-place manager approval | Sheet | No cashier logout |
| POS-APR-002 | P0 | Approve exceptional discount | Sell | requester + approver + reason |
| POS-APR-003 | P0 | Approve price override | Sell | audit |
| POS-APR-004 | P0 | Approve cashier return/refund | Return | role policy |
| POS-APR-005 | P0 | Approve outside-window return | Return | audit |
| POS-APR-006 | P0 | Permission denied human state | Relevant screen | No raw auth error |

## 6.11 Shift / drawer / day close

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-SHIFT-001 | P0 | Open shift | WF-SHIFT-01 | Opening cash |
| POS-SHIFT-002 | P0 | Record cashier/counter per sale | Background | Accountability |
| POS-SHIFT-003 | P0 | Cash in | WF-CASH-01 | Amount + reason + actor |
| POS-SHIFT-004 | P0 | Cash out | WF-CASH-01 | Amount + reason + actor |
| POS-SHIFT-005 | P0 | Expected cash | Shift | Derived |
| POS-SHIFT-006 | P0 | Counted cash | Shift | User input |
| POS-SHIFT-007 | P0 | Variance short/over | Shift | Never silently corrected |
| POS-SHIFT-008 | P0 | Close shift | Shift | Immutable close record |
| POS-SHIFT-009 | P0 | Shift left open overnight warning | Shift/day | Explicit |
| POS-DAY-001 | P0 | Day totals by payment method | WF-DAY-01 | All counters |
| POS-DAY-002 | P0 | Returns/discount totals | Day | Reports |
| POS-DAY-003 | P0 | Cash position | Day | Drawer |
| POS-DAY-004 | P0 | Pending offline/sync count | Day | Explicit |
| POS-DAY-005 | P0 | Closed day immutable | Domain | Correction = new entry |

## 6.12 Inventory seam / standalone catalogue

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-INV-001 | P0 | Inventory catalogue read/cache | Sell | No direct DB |
| POS-INV-002 | P0 | Variant/barcode/price/tax mapping | Sell | Inventory source |
| POS-INV-003 | P0 | Stock availability display | Sell | Human freshness |
| POS-INV-004 | P0 | Limited-stock hold/reserve | Background | Inventory authority |
| POS-INV-005 | P0 | Hold confirm/release | Background | Retry/reconcile |
| POS-INV-006 | P0 | Completed sale stock event | Background | Inventory |
| POS-INV-007 | P0 | Return stock event | Background | Inventory |
| POS-INV-008 | P0 | Exchange stock effects | Background | Inventory |
| POS-INV-009 | P0 | Safe degradation when Inventory unavailable | Sell | Sale mode per configuration |
| POS-STAND-001 | P0 | Standalone own item list | Sell/admin | No Inventory required |
| POS-STAND-002 | P0 | Import catalogue from Inventory/CSV | Admin | Migration/setup |
| POS-STAND-003 | P0 | Standalone pricing works | Sell | Shared pricing package |

## 6.13 CRM seam

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-CRM-001 | P0 | CRM customer lookup | Customer | Automatic |
| POS-CRM-002 | P0 | CRM customer create/update | Customer | Automatic |
| POS-CRM-003 | P0 | Sale event to CRM | Background | Automatic |
| POS-CRM-004 | P0 | Return/exchange event to CRM | Background | Automatic |
| POS-CRM-005 | P0 | Dues/payment change to CRM | Background | Automatic |
| POS-CRM-006 | P0 | Consent sync | Background | Automatic |
| POS-CRM-007 | P0 | CRM unavailable safe UX | Customer/Sell | Continue sale where safe |

## 6.14 Sync / offline stage 1

| ID | P | Feature | Screen | Rule |
|---|---|---|---|---|
| POS-SYNC-001 | P0 | Online state | Home/More | Human label |
| POS-SYNC-002 | P0 | Unstable connection state | Relevant | Work safe message |
| POS-SYNC-003 | P0 | Waiting-to-sync state | WF-SYNC-01 | Human label |
| POS-SYNC-004 | P0 | Pending transaction count/list | Sync/day | Visible |
| POS-SYNC-005 | P0 | Idempotent retry/outbox | Background | No duplicates |
| POS-SYNC-006 | P0 | Pending Inventory hold reconciliation | Background/admin | Never expose raw term to cashier |
| POS-OFF-001 | P0 | Active basket survives line blink | Sell | Stage 1 |
| POS-OFF-002 | P0 | Stage-1 retry of safe completed work | Background | Server authority preserved |
| POS-OFF-003 | P2 | Extended full offline billing | Future | Requires explicit conflict/numbering design |

## 6.15 Reports

| ID | P | Feature | Screen |
|---|---|---|---|
| POS-RPT-001 | P0 | Today sales | WF-REPORTS-01 |
| POS-RPT-002 | P0 | Sales by payment method | Reports |
| POS-RPT-003 | P0 | Sales by cashier | Reports |
| POS-RPT-004 | P0 | Sales by counter | Reports |
| POS-RPT-005 | P0 | Returns/exchanges | Reports |
| POS-RPT-006 | P0 | Discounts/overrides | Reports |
| POS-RPT-007 | P0 | Tax summary | Reports |
| POS-RPT-008 | P0 | Cash variance | Reports |
| POS-RPT-009 | P0 | Outstanding orders/dues | Reports |
| POS-RPT-010 | P0 | Day close | Reports |
| POS-RPT-011 | P1 | Top-selling products | Reports |

## 6.16 Settings / devices

| ID | P | Feature | Screen |
|---|---|---|---|
| POS-SET-001 | P0 | Business: name/GSTIN/address/logo | Settings |
| POS-SET-002 | P0 | Billing: invoice format/financial year/rounding | Settings |
| POS-SET-003 | P0 | Payment methods enabled | Settings |
| POS-SET-004 | P0 | Receipt footer/print setup | Settings |
| POS-SET-005 | P0 | Discount limits | Settings |
| POS-SET-006 | P0 | Return window/rules | Settings |
| POS-SET-007 | P0 | Hold threshold | Settings |
| POS-SET-008 | P0 | Role-gated settings | Settings |
| POS-DEV-001 | P1 | Counter/device registration | WF-DEVICES-01 |
| POS-DEV-002 | P1 | Printer assignment/status | Devices |
| POS-DEV-003 | P1 | Scanner/camera capability status | Devices |
| POS-DEV-004 | P1 | Last sync/connectivity/app version health | Devices |

## 6.17 External integrations

| ID | P | Feature | Rule |
|---|---|---|---|
| POS-API-001 | P1 | Versioned public REST API | `/api/v1/...` from day one |
| POS-API-002 | P1 | Read sales/date range | Public identity |
| POS-API-003 | P1 | Read one bill | Full historical bill |
| POS-API-004 | P1 | Bulk/idempotent item push for standalone | External catalogue |
| POS-API-005 | P1 | Item price/stock update for standalone | Idempotent |
| POS-API-006 | P1 | Customer lookup | Phone/public identity |
| POS-API-007 | P1 | Day-close read | Accounting integration |
| POS-WEB-001 | P1 | Per-client webhook endpoints | Signed |
| POS-WEB-002 | P1 | Monotonic sequence | Out-of-order safety |
| POS-WEB-003 | P1 | Event version | Contract evolution |
| POS-WEB-004 | P1 | Delivery lease/reclaim | Worker crash safety |
| POS-WEB-005 | P1 | HMAC timestamp + raw body | Replay defence |
| POS-WEB-006 | P1 | Retry/delivery history | Integrator visibility |
| POS-EXP-001 | P1 | CSV/Excel item import | No-developer path |
| POS-EXP-002 | P1 | CSV/Excel sales/day export | Accountant path |

## 6.18 Compliance-ready / future fields

| ID | P | Feature | Rule |
|---|---|---|---|
| POS-COMP-001 | P0 | Preserve IRN/ackNo/signedQR fields | Schema-ready; nullable until enabled |
| POS-COMP-002 | P2 | E-invoicing workflow | Enable when client/legal requirement applies |

---

# 7. Cross-Module Contracts

## Inventory -> POS

- Product public identity.
- Variant identity and attributes.
- Barcode/SKU/item code.
- Selling price.
- HSN/tax rate.
- Stock availability and store/location.
- Offer inputs authored by the owning system.

## POS -> Inventory

- `sale.completed`
- `sale.returned`
- `sale.exchanged`
- reserve/confirm/release requests for limited stock.

## CRM -> POS

- Customer public identity.
- Phone/name.
- Recent purchases.
- Visit count/lifetime spend.
- Outstanding balance.
- Loyalty/store credit when enabled.
- Consent status.

## POS -> CRM

- Customer create/update.
- Sale.
- Return/exchange.
- Later payment/dues change.
- Consent.

## Canonical event minimums

| Event | Producer | Consumers | Minimum payload |
|---|---|---|---|
| `sale.completed` | POS | Inventory, CRM, integrations | invoiceNo, shop, counter, customerRef?, lines, totals, payments, occurredAt |
| `sale.returned` | POS | Inventory, CRM, integrations | creditNoteNo, originalInvoiceNo, lines, refund, reason, occurredAt |
| `sale.exchanged` | POS | Inventory, CRM | originalInvoiceNo, creditNoteNo, newInvoiceNo, lines, difference |
| `customer.created` | POS/CRM | CRM/POS | customerRef, phone, name, consent |
| `customer.updated` | POS/CRM | CRM/POS | customerRef, changed fields |
| `payment.updated` | POS | CRM/integrations | invoice/order ref, method, amount, status, collectedAt |
| `order.status_changed` | POS | CRM/integrations | order ref, customerRef, status, due, collection date |
| `day.closed` | POS | reporting/accounting integration | shop, date, totals by method, returns, cash variance |

**Every event write/delivery must be safe to retry.**

---

# 8. Permission Baseline

| Capability | Owner | Manager | Cashier |
|---|---:|---:|---:|
| Sell | Yes | Yes | Yes |
| Discount within cashier limit | Yes | Yes | Yes |
| Discount above cashier limit | Yes | Yes | Approval required |
| Price override | Yes | Yes | Approval required / policy |
| Return/refund | Yes | Yes | Approval required |
| Return outside window | Yes | Yes | No without approval |
| Cash in/out | Yes | Yes | Policy-controlled |
| Close shift | Yes | Yes | Own shift where allowed |
| Close day | Yes | Yes | No |
| Operational reports | Yes | Yes | Limited |
| Settings/integrations | Yes | No/limited | No |
| Cost/profit | **Not a core POS capability** | **Not a core POS capability** | No |

Permissions are data-driven rows, not database enums.

---

# 9. Required Screen States

For every applicable screen explicitly account for:

- Default/ready.
- Loading.
- Empty.
- No results.
- Success.
- Validation failure.
- Service/integration failure.
- Offline/unstable.
- Permission denied.
- Partial data/stale data where relevant.

A state may be `N/A`, but the agent must state why.

## Error language rule

Every expected error answers:

1. What happened?
2. Is the user's work safe?
3. What should they do next?

Example:

**Do not show:** `409 HOLD_CONFIRMATION_FAILED`  
**Show:** `Stock confirmation is taking longer than usual. Your sale is safe. We'll keep trying.`

---

# 10. Build Order — Complete Vertical Slices

| Phase | Outcome | Must not advance until |
|---|---|---|
| 0 | Foundation + responsive shell | Core guards, mobile shell, money/idempotency/numbering/auth pass |
| 1 | Sell + cash + receipt + bill history | A real cash sale can be made/found/reprinted on all devices |
| 2 | UPI/card/split + payment safety | Payment retry/unknown scenarios pass |
| 3 | Customer + CRM seam | Lookup/create/history/event path works and failure degrades safely |
| 4 | Discounts/overrides + approvals | Manager-in-place approval and audit pass |
| 5 | Orders/keep/dues | Advance, due, collect, ready, handover pass |
| 6 | Returns + exchange | Credit note, stock/customer effects and difference settlement pass |
| 7 | Shift + cash movements + day close | Drawer/day reconciliation passes |
| 8 | Inventory seam + standalone | Inventory-connected and standalone modes both work |
| 9 | Operational reports | All P0 reports reconcile to source transactions |
| 10 | Digital receipts + devices | Async receipt failures cannot damage sale |
| 11 | Offline Stage 1 / sync UX | Basket/retry/pending states pass without duplicates |
| 12 | Public API + webhooks + CSV/Excel | Contract/retry/security tests pass |
| 13 | Real-shop pilot + cut-over | Full day balances; history remains readable/reprintable/returnable |

**Removal of the old Inventory counter-sale implementation happens only after the pilot/cut-over gate passes.**

---

# 11. AI Build Protocol — Mandatory

## Step 1 — Read

Read:

- this master specification,
- `FEATURES.md`, `FLOWS.md`, `CONTRACTS.md`, `BUILD.md`, `QA.md`, `CHANGELOG.md` if present,
- the requested module brief,
- relevant existing code/tests/migrations/routes/components.

**No code changes yet.**

## Step 2 — Discover all affected functionality

Search the repository for:

- Feature IDs and terminology.
- Routes and screens.
- Components/hooks/services.
- DB models/migrations.
- API handlers/services.
- Event producers/consumers.
- Permissions.
- Tests/verification scripts.
- Imports/exports and external consumers.
- Old/legacy implementation of the same business capability.

Do not inspect only the obvious folder.

## Step 3 — Preflight

Return:

```text
MODULE:
GOAL:

REQUIRED FEATURE IDS: N
DONE IN CURRENT CODE: N
PARTIAL: N
MISSING: N
CONFLICTING/LEGACY: N

SCREENS AFFECTED:
FLOWS AFFECTED:
MODULES AFFECTED:
APIS/SERVICES AFFECTED:
EVENTS AFFECTED:
DB/MIGRATIONS AFFECTED:
PERMISSIONS AFFECTED:
MOBILE/TABLET/DESKTOP IMPACT:
TESTS REQUIRED:
RISKS / BLOCKERS:

UNACCOUNTED APPROVED FEATURES: 0   # must be zero before build
NO CODE CHANGED.
```

If an approved feature cannot be mapped, stop and report it. Do not drop it.

## Step 4 — Trace every feature

For each feature in scope:

```text
Feature ID
-> user flow
-> screen(s)
-> every action destination
-> API/service
-> data/storage
-> producer/consumer events
-> Inventory effect
-> CRM effect
-> payment effect
-> permission/approval
-> audit
-> offline/retry
-> responsive behaviour
-> acceptance tests
```

## Step 5 — Plan exact changes

List exact files to create/modify/remove and why. Include migrations, APIs, screens, integration contracts and tests.

Do not make unrelated cleanup changes during a feature build unless required for correctness and reported first.

## Step 6 — Build smallest complete vertical slice

Do not build five beautiful screens with missing backend effects. Finish one usable end-to-end capability at a time.

## Step 7 — Verify mechanically

Run the relevant automated tests and verification scripts. Then verify the actual user flow, not just isolated functions.

Check:

- feature coverage,
- flow coverage,
- screen/action-link coverage,
- phone/tablet/desktop,
- API/service coverage,
- Inventory/CRM/payment effects,
- permissions/approvals,
- audit,
- empty/loading/error/offline states,
- idempotency/retry,
- migrations/backward compatibility.

## Step 8 — Reconcile against requirement again

**Re-read the original requirement and feature registry after coding.**

Ask: `What was required that I did not implement or verify?`

Do not verify only the things you remember building.

## Step 9 — Update registries

Update feature status, flow/screen links, contracts, tests and changelog where approved.

Never mark `DONE` without evidence.

## Step 10 — Close with evidence

```text
REQUIRED FEATURES:       32/32 accounted
IMPLEMENTED:             32/32
FLOW LINKS:              18/18
SCREEN ACTION LINKS:     41/41
PHONE P0:                 8/8
TABLET P0:                8/8
DESKTOP P0:               8/8
INTEGRATION CONTRACTS:    6/6
PERMISSIONS:              5/5
EDGE STATES:             22/22
TESTS:                   74/74 passing
UNAPPROVED REMOVALS:      0
UNACCOUNTED FEATURES:     0
BLOCKERS:                 0

STATUS: COMPLETE
```

If any required count is below 100%, status is `INCOMPLETE`, `BLOCKED`, or `DEFERRED WITH APPROVAL` — never COMPLETE.

---

# 12. Completion Gates

## Feature gate

A feature is `DONE` only when all applicable checks are explicitly satisfied:

```text
[ ] Feature ID exists
[ ] Requirement is understood
[ ] Happy path mapped
[ ] Screen(s) registered
[ ] Every action destination registered
[ ] Phone behaviour
[ ] Tablet behaviour
[ ] Desktop/counter behaviour
[ ] API/service
[ ] Data/storage
[ ] Inventory impact checked
[ ] CRM impact checked
[ ] Payment impact checked
[ ] Permission/approval checked
[ ] Audit checked
[ ] Retry/idempotency checked
[ ] Offline/unstable behaviour checked
[ ] Empty/loading/no-result/error states checked
[ ] Tests written
[ ] Tests passing
[ ] Original requirement re-read
[ ] Feature registry updated
```

`N/A` requires a reason.

## Screen gate

```text
[ ] Screen ID
[ ] Purpose
[ ] Opens from
[ ] Primary CTA
[ ] Secondary actions
[ ] Destination for every action
[ ] Phone
[ ] Tablet
[ ] Desktop
[ ] Empty
[ ] Loading
[ ] No results
[ ] Success
[ ] Error
[ ] Offline/unstable if relevant
[ ] Permission denied if relevant
```

## Module gate

Required before moving on:

| Coverage | Gate |
|---|---:|
| Approved feature IDs accounted | 100% |
| Implemented scope | 100% or explicitly approved defer/block |
| Screen/wireframe coverage | 100% |
| Action/link coverage | 100% |
| P0 responsive flows | 100% |
| APIs/services | 100% |
| Required integrations | 100% |
| Permissions/approvals | 100% |
| P0 edge/error states | 100% |
| Required tests | 100% passing |
| Unapproved removals | 0 |
| Unaccounted approved features | 0 |

---

# 13. AI Anti-Forget / Anti-Regression Rules

1. **Do not trust memory. Re-read the registries.**
2. Absence from current code does not mean a feature was removed.
3. Never silently remove or rename a feature, route, screen, API, event, permission, data field or integration.
4. Before changing a contract, search all producers and consumers.
5. Before deleting a field, search historical reads, reports, receipts, integrations and migrations.
6. Do not duplicate business logic because the existing implementation lives in another module; integrate or extract shared logic.
7. Do not infer that a beautiful UI means a feature is complete.
8. Do not mark a module complete from code inspection alone; execute tests and the actual flow.
9. Do not replace a working capability with a simplified version unless every previous approved behaviour is mapped.
10. Do not convert an unresolved requirement into `N/A`.
11. If a feature is blocked, keep it visible in the ledger.
12. If the user changes scope, record the change before deleting old behaviour.
13. Historical invoices/sales must remain readable, reprintable and returnable across cut-over.
14. A new migration must not silently reinterpret historical financial facts.
15. If the agent finds an unexpected existing feature, add it to preflight and reconcile whether it is approved/legacy before touching it.

## Proposed removal format

```text
PROPOSED REMOVAL
ID:
Feature/screen/API/event:
Reason:
Current users/consumers:
Affected modules:
Affected data/history:
Migration/backward compatibility:
Replacement (if any):
Recommendation:

STATUS: AWAITING APPROVAL
```

No approval = no removal.

---

# 14. QA Scenarios That Must Exist

At minimum, verify these before commercial release:

| Area | Scenario | Pass condition |
|---|---|---|
| Sell | Rapid repeated barcode scan | Correct quantities; no dropped/duplicate unintended lines; target <150ms perceived add |
| Basket | Refresh/crash with populated basket | Exact basket restored |
| Sale | Double press Complete / timeout retry | One invoice only |
| Money | GST/discount/rounding edge cases | Totals invariant and day close balances |
| Payment | Split amount short/over | Completion blocked with exact difference |
| Payment | Provider debit but timeout | Needs-checking state; no blind second charge |
| Customer | Customer refuses phone | Sale completes normally |
| Customer | Concurrent same-phone create | One customer identity per configured rule |
| Orders | Partial balance collection | Due and payment history correct |
| Orders | Handover with due | Explicit warning/approval path |
| Return | Partial previous return | Cannot return more than remaining eligible qty |
| Return | Outside return window | Correct manager approval path |
| Exchange | Replacement higher/lower price | Only difference collected/refunded |
| Approval | Cashier exceeds discount | In-place manager approval; cashier context preserved |
| Cash | Petty cash removed | Cash-out explains drawer expectation |
| Shift | Short/over drawer | Difference recorded, never silently corrected |
| Day | Open shift overnight | Explicit warning at day close |
| Offline | Network blinks mid-basket | Basket safe + human status |
| Retry | Pending sale/event retried | No duplicate financial/stock/customer effect |
| Inventory | Inventory slow/unavailable | UI does not freeze; configured safe behaviour used |
| CRM | CRM unavailable | Sale remains usable where safe; customer limitation explained |
| Receipt | Printer unavailable | Sale remains complete; reprint available |
| History | Product renamed after sale | Old bill still shows original description/price/tax |
| Permissions | Cashier tries restricted action | Human denial/approval path; no data leak |
| Mobile | Portrait phone | No critical horizontal scroll; primary CTA reachable |
| Desktop | Scanner/keyboard sale | Mouse not required for normal high-speed flow |
| Cut-over | Historical old sale | Readable, reprintable and returnable |

---

# 15. Product Features Deliberately Outside Core POS

Do not allow AI scope creep into:

- Supplier management.
- Purchase orders/procurement.
- Full stock administration.
- Cost/margin analytics on cashier surfaces.
- Full CRM/campaign builder.
- General ledger/accounting system.
- Large BI dashboards.
- Full offline conflict resolution in the first release.
- AI functionality required for ordinary selling.
- Direct cross-module database writes.

These may exist elsewhere in ScaleEzy; POS should integrate rather than absorb them.

---

# 16. Decisions Locked for This Build

1. Phone support is required; the previous “hide below 768px” rule is retired.
2. Primary mobile navigation is `Home / Sell / Orders / Customers / More`.
3. POS and Inventory retain a hard ownership boundary.
4. CRM owns relationship depth; POS receives compact selling context.
5. Bill history is P0.
6. Cash In / Cash Out is P0.
7. In-place manager approval is P0.
8. Payment ambiguous/needs-checking state is P0 even before deep provider integration.
9. Offline promise is Stage 1 until full-offline conflicts/numbering are explicitly designed.
10. Operational reports stay small.
11. Cost/profit is not a core POS user capability.
12. External integration includes REST + signed webhooks + CSV/Excel; spreadsheet path must not be skipped.
13. Historical financial facts are immutable snapshots.
14. Old counter-sale removal occurs only after real-shop pilot and day-close reconciliation.

---

# 17. Short Module Brief Template

Humans should not need a 20-page prompt for each module. Use:

```text
MODULE:

USER JOB:

FEATURE IDS:

SCREENS:

HAPPY PATH:
1.
2.
3.

OTHER MODULES AFFECTED:

PERMISSIONS / APPROVALS:

IMPORTANT EDGE CASES:

MUST NOT DO:

DONE WHEN:
```

The AI must fill missing technical detail during preflight from the master registry and codebase. It may not treat a blank human brief as permission to omit registered features.

---

# 18. Copy-Paste Master Prompt for Coding Agents

```text
You are implementing ScaleEzy.

READ BEFORE CODE:
1. Read docs/product/MASTER.md completely.
2. Read FEATURES.md, FLOWS.md, CONTRACTS.md, BUILD.md, QA.md and CHANGELOG.md if present.
3. Read the requested module brief.
4. Inspect the relevant code, tests, migrations, routes, screens, services, event producers and consumers.

DO NOT WRITE CODE YET.

The product registry is authoritative. Existing code may be incomplete. Absence from current code does not mean a feature was intentionally removed.

FIRST perform a read-only preflight:
- enumerate every relevant approved Feature ID;
- classify each as DONE / PARTIAL / MISSING / CONFLICTING / BLOCKED;
- identify every affected user flow and registered screen;
- map every button/action to a destination;
- identify every affected API/service, DB model/migration, event producer/consumer and permission;
- identify Inventory, CRM, payment, shift, report, audit and external-integration effects;
- identify phone, tablet and desktop behaviour;
- identify empty/loading/no-result/error/offline/permission states;
- identify tests required;
- search upstream producers and downstream consumers before proposing contract changes;
- report any approved feature you cannot account for.

Your preflight must end with:
UNACCOUNTED APPROVED FEATURES: 0
NO CODE CHANGED.

If the first number cannot be zero, stop and report the gap. Do not build around it.

Then give the exact vertical-slice implementation plan and exact files to create/modify/remove. Do not make unrelated changes.

After approval, implement the smallest COMPLETE vertical slice.

HARD RULES:
- Never silently remove, rename, simplify or replace an approved feature, screen, route, API, event, permission, field or integration.
- Never create duplicate business logic that belongs to another ScaleEzy module.
- Never expose technical architecture to store users.
- Never mark an ambiguous payment as failed if the provider may have collected money.
- Never write directly into Inventory or CRM databases from POS.
- Never make historical invoices depend on current product/price/tax data.
- Never declare completion based only on the code you remember writing.

BEFORE COMPLETION:
1. Run tests/verification.
2. Execute or inspect the actual user flow.
3. Re-read the original request and feature registry.
4. Ask: What required feature, link, state, integration, permission or edge case is still absent?
5. Update the feature/flow/contract/QA ledgers.

Return a coverage report with exact counts:
REQUIRED FEATURES x/x
IMPLEMENTED x/x
FLOW LINKS x/x
SCREEN ACTION LINKS x/x
PHONE P0 x/x
TABLET P0 x/x
DESKTOP P0 x/x
APIS/SERVICES x/x
INTEGRATION CONTRACTS x/x
PERMISSIONS x/x
EDGE STATES x/x
TESTS x/x PASSING
UNAPPROVED REMOVALS 0
UNACCOUNTED APPROVED FEATURES 0
BLOCKERS 0

STATUS may be COMPLETE only if every required count is satisfied, all required tests pass, unapproved removals are zero, and unaccounted approved features are zero.
Otherwise state INCOMPLETE or BLOCKED and list exactly what remains.
```

---

# 19. Definition of Product Complete

The POS is not complete because the screens look polished.

It is complete only when:

- A first-time user can sell without training.
- Phone, tablet and counter flows work.
- Every approved P0 Feature ID is accounted for.
- Every action has a destination.
- Every applicable cross-module effect is implemented and verified.
- Payments are safe under retry/ambiguity.
- Inventory and CRM failures degrade safely.
- Returns, exchanges, dues, approvals, shifts and day close work in real retail conditions.
- Historical bills remain trustworthy.
- Required tests pass.
- A real-shop pilot balances through day close.
- No approved feature disappeared during AI implementation.

> **Requirement → Feature ID → Flow → Screen → Contract → Code → Test → Evidence.**
>
> If one required link is missing, the feature is not complete.
