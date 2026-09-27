# ScaleEzy — AI Build Playbook

**Version:** 1.0  
**Purpose:** The single execution guide for building ScaleEzy modules quickly with AI **without losing features, screens, links, integrations, edge cases, or mobile usability**.

---

# 1. The Product Rule

> **Complexity belongs in the system, never on the screen.**

ScaleEzy must feel as easy as Instagram or Facebook. A Class 7 student should be comfortable using the core product without training.

For POS, the experience is:

> **Open → Scan/Search → Pay → Done.**

The same simplicity rule applies to every ScaleEzy module.

### Non-negotiables

1. Mobile, tablet and desktop are first-class experiences.
2. One obvious primary action per screen.
3. Maximum five primary navigation destinations on mobile.
4. Use plain human language; never expose engineering terminology to users.
5. Automate what the system can decide safely.
6. Never make users understand how modules integrate.
7. Never lose user work because of refresh, crash or temporary connectivity loss.
8. A feature is not complete until its UI, logic, integrations, permissions, edge cases and tests are complete.
9. AI must never silently remove, simplify or forget an existing feature.
10. The master product registry—not AI memory—is the source of truth.

---

# 2. Simple Repository Documentation Structure

Do **not** create a maze of documentation folders.

Use one simple product folder:

```text
docs/
└── product/
    ├── 00-MASTER.md
    ├── 01-FEATURES.md
    ├── 02-FLOWS.md
    ├── 03-SCREENS.md
    ├── 04-INTEGRATIONS.md
    ├── 05-BUILD.md
    ├── 06-QA.md
    └── CHANGELOG.md
```

That is enough.

### What each file does

| File | Purpose |
|---|---|
| `00-MASTER.md` | Product brief, principles, architecture, module ownership and decisions |
| `01-FEATURES.md` | Every approved feature with a permanent ID and status |
| `02-FLOWS.md` | User journeys and links between screens/modules |
| `03-SCREENS.md` | Screen/wireframe registry, states and actions |
| `04-INTEGRATIONS.md` | POS ↔ Inventory ↔ CRM ↔ Gateway ↔ payments/API contracts |
| `05-BUILD.md` | Current build plan, dependencies, order and execution status |
| `06-QA.md` | Acceptance tests and feature/flow/mobile/integration coverage |
| `CHANGELOG.md` | Approved additions, changes and removals |

**Rule:** Do not create another document if the information belongs in one of these seven files.

---

# 3. Source of Truth

The AI must read these before modifying a module:

```text
00-MASTER.md
01-FEATURES.md
02-FLOWS.md
03-SCREENS.md
04-INTEGRATIONS.md
05-BUILD.md
06-QA.md
```

Then inspect the actual code.

### Authority order

When information conflicts, use:

1. Approved latest decision in `CHANGELOG.md`
2. `00-MASTER.md`
3. `01-FEATURES.md`
4. `02-FLOWS.md` / `03-SCREENS.md`
5. `04-INTEGRATIONS.md`
6. Existing code

Existing code is **not automatically the requirement**. Code may be incomplete.

---

# 4. Permanent Feature IDs

Every real product feature receives an ID.

Examples:

```text
POS-SELL-001  Product Search
POS-SELL-002  Barcode Scan
POS-SELL-003  Variant Selection
POS-CUST-001  Customer Lookup
POS-PAY-001   Cash Payment
POS-PAY-004   Split Payment
POS-ORD-003   Collect Balance
POS-RET-002   Exchange
POS-INV-001   Product Catalogue Integration
POS-CRM-001   Customer Integration
```

Do not renumber IDs because a feature moves on the roadmap.

If a feature is intentionally removed, retain the ID and mark it `REMOVED` with an approved reason in the changelog.

---

# 5. The Feature Registry

`01-FEATURES.md` is the master checklist.

Every feature uses one row:

| ID | Feature | Priority | Screen | Inventory | CRM | Mobile | Permission | Test | Status |
|---|---|---|---|---|---|---|---|---|---|
| POS-SELL-001 | Product Search | P0 | WF-SELL-01 | Yes | N/A | Yes | Sell | PASS | DONE |
| POS-CUST-001 | Customer Lookup | P0 | WF-CUST-01 | N/A | Yes | Yes | Sell | PASS | DONE |

Allowed status values:

```text
PLANNED
READY
BUILDING
BLOCKED
VERIFY
DONE
REMOVED
```

### Completion rule

A feature cannot be `DONE` if a required column is blank.

`N/A` is allowed, but it must genuinely not apply.

---

# 6. Screen & Wireframe Registry

Every screen receives an ID.

Examples:

```text
WF-HOME-01
WF-SELL-01
WF-PAY-01
WF-CUST-01
WF-ORDER-01
WF-SALE-01
WF-RETURN-01
WF-SHIFT-01
```

`03-SCREENS.md` contains:

| Screen ID | Name | Opens From | Primary Action | Goes To | Mobile | Status |
|---|---|---|---|---|---|---|
| WF-HOME-01 | Home | Login | New Sale | WF-SELL-01 | Yes | DONE |
| WF-SELL-01 | Sell | Home | Continue | WF-PAY-01 | Yes | BUILDING |

### Every clickable action must answer:

> **Where does this go?**

No dead buttons.

No unlinked screens.

No wireframe that exists only as an image without being registered.

---

# 7. Flow Map

`02-FLOWS.md` keeps the journeys simple and visible.

Example:

```text
HOME
  ↓ New Sale
SELL
  ├─ Search / Scan
  ├─ Select Variant
  ├─ Add Customer → CUSTOMER → back to SELL
  ├─ Discount → Manager Approval → back to SELL
  ↓ Continue
PAYMENT
  ├─ Cash
  ├─ UPI
  ├─ Card
  └─ Split
  ↓
SUCCESS
  ├─ Print
  ├─ Send Receipt
  └─ New Sale → SELL
```

A second flow can show module effects:

```text
COMPLETE SALE
     │
     ├── POS → saves invoice + payment
     ├── Inventory → stock movement
     ├── CRM → customer purchase history
     ├── Shift → payment/cash totals
     ├── Reports → sales totals
     └── Webhook → external systems
```

This prevents AI from completing a screen while forgetting everything that should happen behind it.

---

# 8. ScaleEzy POS Product Architecture

```text
                SCALEEZY EXPERIENCE

       Mobile       Tablet       Desktop
          \            |            /
           \           |           /
            ─────── POS UI ───────
                     |
     Home | Sell | Orders | Customers | More
                     |
                 POS DOMAIN
                     |
       ┌─────────────┼──────────────┐
       |             |              |
       v             v              v
   INVENTORY        CRM          PAYMENTS
       |             |              |
       └─────────────┼──────────────┘
                     |
                   GATEWAY
                     |
           API / WEBHOOK / EXPORT
```

### Ownership

**POS owns:**
- Sale
- Basket
- Payment record
- Receipt
- Return/exchange transaction
- Kept/customer order transaction
- Shift/day close

**Inventory owns:**
- Product
- Variant
- Barcode/SKU
- Stock
- Stock movement
- Purchase/supplier processes
- Cost price

**CRM owns:**
- Customer relationship
- Customer profile depth
- Communication history
- Segmentation
- Marketing lifecycle

**Gateway owns:**
- Authentication
- Tenant/module entitlement
- Module access
- Secure routing/contracts

### Hard rule

POS never writes directly to Inventory or CRM databases.

Integrations use approved service/API/event contracts.

---

# 9. POS Navigation

Mobile primary navigation:

```text
HOME | SELL | ORDERS | CUSTOMERS | MORE
```

Do not add more primary tabs without explicit product approval.

### Cashier experience

The cashier should primarily use:

```text
SELL
ORDERS
CUSTOMERS
```

Everything advanced stays secondary.

---

# 10. POS Core Feature Scope

## Home

- Today sales
- Bill count
- Orders needing attention
- Shift status
- Connection/sync status
- Recent activity
- **New Sale**

Do not turn Home into a BI dashboard.

## Sell

- Barcode scan
- Mobile camera scan
- SKU/code/name search
- Product images where useful
- Variant selection
- Quantity
- Remove
- Automatic offers
- Manual discount
- Manager-approved exceptional discount
- Price override with approval
- Persistent basket
- Add/select customer
- Hold/park basket
- Continue to payment

Target: barcode → visible basket line in **<150 ms**.

## Payments

- Cash
- Exact cash
- Change due
- UPI
- Card
- Split payment
- Payment reference
- Safe retry/idempotency
- `UNKNOWN / NEEDS CHECKING` state for ambiguous provider results

Never automatically treat an unknown provider result as failed and ask the customer to pay again.

## Customer

- Customer optional
- Phone lookup
- Quick create
- Name
- Consent
- Recent purchases
- Visit count
- Lifetime spend
- Outstanding balance
- Loyalty/store credit when available
- View in CRM

POS must **not** become a full CRM.

## Orders

One user-facing concept: **Orders**.

Internally this can represent kept bills, balances and collection workflows.

User-facing statuses:

```text
Waiting
Ready
Due
Complete
```

Features:

- Keep for customer
- Advance payment
- Balance due
- Collection date
- Notes
- Collect balance
- Mark ready
- Hand over
- Warning before handover if money remains due
- Park/recall active basket

## Sales

- Bill history
- Search by invoice
- Search by phone/customer
- Date
- Payment method
- Status
- Bill details
- Payments
- Customer
- Reprint
- Digital receipt
- Return
- Exchange

## Returns & Exchange

Start from the original bill.

- Select line
- Select quantity
- Reason
- Return
- Exchange
- Replacement variant/product
- Settle only difference
- Refund
- Store credit where enabled
- Credit note
- Manager approval when required

## Shift & Cash

- Open shift
- Opening cash
- Cash in
- Cash out
- Reason
- Expected cash
- Counted cash
- Difference
- Close shift
- Day close

## Reports

Keep reports small and operational:

- Today sales
- Payment methods
- Cashier
- Counter
- Returns
- Discounts
- Tax
- Cash variance
- Outstanding orders
- Day close

Advanced analytics belong elsewhere.

---

# 11. Inventory Integration Contract

POS should feel as if Inventory is simply part of it.

### Inventory → POS

- Product
- Variant
- Barcode/SKU
- Selling price
- HSN/tax
- Stock availability
- Store/location
- Offer inputs

### POS → Inventory

- Sale completed
- Return completed
- Exchange completed
- Hold/reservation request
- Hold confirmation/release

### User experience

Never show:

```text
Inventory API failed
Outbox pending
Hold reconcile failed
Gateway timeout
```

Show:

```text
Stock update is taking longer than usual.
Your sale is safe.
```

---

# 12. CRM Integration Contract

### CRM → POS

- Customer identity
- Phone/name
- Recent purchases
- Visit count
- Lifetime spend
- Outstanding balance
- Loyalty/store credit
- Consent

### POS → CRM

- New customer
- Customer update
- Sale
- Return
- Exchange
- Payment
- Outstanding balance change
- Consent

### Rule

The cashier should never have to press **Sync CRM**.

Integration is automatic.

---

# 13. Cross-Module Feature Contract

Before building a feature, AI must identify every affected module.

Example:

```text
FEATURE
POS-SELL-020 — Complete Sale

POS
✓ Invoice
✓ Lines
✓ Payment
✓ Receipt

INVENTORY
✓ Stock movement
✓ Hold confirmation if applicable

CRM
✓ Purchase history
✓ Customer spend update

SHIFT
✓ Payment/cash totals

REPORTS
✓ Sales totals

AUDIT
✓ Sensitive actions where applicable

INTEGRATIONS
✓ sale.completed event
```

If one expected effect is missing, the feature is incomplete.

---

# 14. The AI Build Protocol

This is mandatory for every AI coding agent.

## STEP 1 — READ

Read the seven product documents and inspect the relevant code.

Do not code yet.

## STEP 2 — PREFLIGHT

Return a short preflight:

```text
MODULE:
GOAL:

Features required: 32
Already complete: 14
Partial: 6
Missing: 12

Screens affected: 5
Modules affected: POS, Inventory, CRM
APIs affected: 8
DB changes: 1
Risks/open questions: 3

No code changed.
```

## STEP 3 — TRACE

For every feature being changed, map:

```text
Feature ID
→ Flow
→ Screen
→ API/service
→ Data
→ Other modules
→ Permission
→ Tests
```

## STEP 4 — PLAN

State exactly:

- Files to create
- Files to modify
- Files to remove
- API changes
- DB changes
- Screen changes
- Integration changes
- Tests

Do not make unrelated changes.

## STEP 5 — BUILD

Implement the approved scope.

Build the smallest complete vertical slice rather than many half-finished screens.

## STEP 6 — VERIFY

Verify against the registry—not against what the AI remembers building.

Run:

- Feature coverage
- Flow coverage
- Screen/link coverage
- Mobile coverage
- Integration coverage
- Permission coverage
- Edge-case coverage
- Tests

## STEP 7 — RECONCILE

Compare the finished implementation with the original requirement again.

Ask:

> What was required that is still absent?

This step is mandatory because AI often verifies only what it implemented.

## STEP 8 — CLOSE

A module can close only with a completion report:

```text
Required features: 32/32
Implemented:       32/32
Screens linked:     8/8
Mobile checked:     8/8
Integrations:       6/6
Permissions:        5/5
Tests:             74/74
Open blockers:        0

STATUS: COMPLETE
```

Anything below 100% must say:

```text
STATUS: INCOMPLETE
```

---

# 15. Feature Completion Gate

A feature is **DONE** only when all applicable items pass:

```text
[ ] Requirement exists
[ ] Feature ID exists
[ ] Flow is mapped
[ ] Screen/wireframe exists
[ ] Every button/action has a destination
[ ] Mobile behaviour exists
[ ] Tablet behaviour exists
[ ] Desktop behaviour exists
[ ] API/service exists
[ ] Data/storage exists
[ ] Inventory impact checked
[ ] CRM impact checked
[ ] Payment impact checked
[ ] Permission checked
[ ] Audit checked
[ ] Offline/retry behaviour checked
[ ] Empty state checked
[ ] Loading state checked
[ ] Error state checked
[ ] Tests written
[ ] Tests passing
[ ] Original requirement re-read
```

Only applicable checks are required. `N/A` must be explicit.

---

# 16. Screen Completion Gate

Every screen must define:

```text
[ ] Purpose
[ ] Opens from
[ ] Goes to
[ ] Primary CTA
[ ] Secondary actions
[ ] Mobile
[ ] Tablet
[ ] Desktop
[ ] Empty
[ ] Loading
[ ] Success
[ ] No results
[ ] Error
[ ] Offline/unstable if relevant
[ ] Permission denied if relevant
```

### Hard rule

**No orphan screens. No dead buttons.**

---

# 17. Module Completion Gate

Before moving to the next module, AI must report:

| Coverage | Required |
|---|---:|
| Features | 100% |
| Screens/wireframes | 100% |
| Screen links | 100% |
| Mobile P0 flows | 100% |
| APIs/services | 100% |
| Required integrations | 100% |
| Permissions | 100% |
| P0 edge cases | 100% |
| Required tests | 100% passing |
| Unapproved removals | 0 |

A visually complete screen is **not** a completed module.

---

# 18. AI Anti-Forget Rules

Every coding agent must follow these rules:

### Rule 1

> **Do not trust your memory. Read the registries.**

### Rule 2

> Absence from current code does not mean a feature was intentionally removed.

### Rule 3

Never silently delete a feature, screen, route, API, event, permission or integration.

### Rule 4

If something appears obsolete, report it first:

```text
PROPOSED REMOVAL
Feature:
Reason:
Affected screens:
Affected modules:
Affected APIs/data:
Migration impact:
Recommended action:
```

Wait for approval before removing it.

### Rule 5

Before changing one module, search for all consumers and producers of the affected data/API/event.

### Rule 6

Do not build a duplicate capability because the existing one is in another module. Reuse or integrate where architecture says so.

### Rule 7

Never mark a module complete from code inspection alone. Execute tests and inspect the actual user flow.

---

# 19. Mobile-First Rules

The earlier POS assumption that selling should disappear below 768 px is retired.

ScaleEzy POS must support:

```text
PHONE
TABLET
DESKTOP/COUNTER
```

Same domain rules; adaptive UI.

### Phone

- Bottom navigation
- Camera barcode scanning
- Large touch targets
- Sticky primary CTA
- Bottom sheets for short decisions
- One-column layouts
- No critical horizontal scrolling

### Tablet

- Touch-first
- More information can stay visible
- Split basket/payment where useful

### Counter/Desktop

- Barcode scanner
- Keyboard-first
- Search focus retained
- Shortcuts
- Fast multi-item operation

Mobile simplicity must **not** make desktop cashier operation slower.

---

# 20. Error Language

Bad:

```text
409 HOLD_CONFIRMATION_FAILED
```

Good:

```text
Stock confirmation is taking longer than usual.
Your sale is safe.
```

Bad:

```text
CRM service unavailable
```

Good:

```text
Customer details aren't available right now.
You can continue the sale.
```

Every expected error must tell the user:

1. What happened.
2. Whether their work is safe.
3. What they should do next.

---

# 21. What POS Must NOT Become

Do not add these to the core POS experience:

- Supplier management
- Purchase orders
- Procurement
- Full stock administration
- Cost-price analysis for cashiers
- Full CRM
- Campaign builder
- General accounting ledger
- Large BI dashboard
- Complex integration configuration for cashiers
- Engineering diagnostics
- AI functionality required for ordinary selling

The product should become more capable without looking more complicated.

---

# 22. Build Order

Use vertical, usable releases:

```text
0. Foundation + responsive shell
1. Sell + cash + receipt + bill history
2. UPI/card/split + payment safety
3. Customer + CRM integration
4. Discounts/overrides + manager approval
5. Orders / keep for customer / dues
6. Returns + exchange
7. Shift + cash in/out + day close
8. Inventory integration
9. Small operational reports
10. Digital receipts + device support
11. Offline Stage 1
12. Public API + webhooks + CSV/Excel
13. Real-shop pilot + cut-over
```

Each phase must leave the product in a usable state.

---

# 23. Fast Module Brief Template

Before asking AI to build any module, fill only this:

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

PERMISSIONS:

IMPORTANT EDGE CASES:

MUST NOT DO:

DONE WHEN:
```

The AI fills the technical detail during preflight after reading the product files and codebase.

Do not make humans write a 20-page specification before every small feature.

---

# 24. Standard Prompt for Any AI Coding Agent

Copy this when starting a module:

```text
You are working on ScaleEzy.

Before writing code, read /docs/product/00-MASTER.md through 06-QA.md and CHANGELOG.md, then inspect the relevant existing implementation.

Do not trust current code as the complete requirement. The product registry is authoritative.

FIRST: perform a read-only preflight. Do not change code.

For this request:
1. Identify every relevant feature ID.
2. Identify existing, partial and missing functionality.
3. Map every affected user flow and screen/wireframe.
4. Identify every affected module, API, event, database model and permission.
5. Search for upstream producers and downstream consumers before proposing changes.
6. Identify mobile, tablet and desktop impact.
7. Identify empty, loading, error, offline/retry and permission states where relevant.
8. Identify tests required.
9. Flag any conflict with the master architecture.
10. Give the exact implementation plan and files affected.

Do not silently remove, rename or replace existing features.
Do not create duplicate logic that belongs to another ScaleEzy module.
Do not expose technical complexity to the end user.

After approval, implement the smallest complete vertical slice.

Before declaring completion, re-read the original requirement and registries and provide:
- feature coverage
- flow coverage
- screen/link coverage
- mobile coverage
- integration coverage
- permission coverage
- tests
- unresolved items

A module is COMPLETE only when all required coverage is 100% and unresolved blockers are zero. Otherwise state INCOMPLETE clearly.
```

---

# 25. Final Product Standard

The engineering can be sophisticated.

The user experience cannot be.

A user should never need to understand:

- which database owns something,
- which event fired,
- which service is syncing,
- why an API retried,
- which module supplied the information.

They should simply see the right information and the obvious next action.

> **Build powerful systems. Show simple screens.**

And for AI development:

> **Requirement → Feature ID → Flow → Screen → Contract → Code → Test → Evidence.**

If one link is missing, the work is not complete.
