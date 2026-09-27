# FLOWS AND SCREEN REGISTRY

Journeys are in `MASTER.md` §5 and are not repeated here. This file tracks **which screens exist,
what they link to, and which links are live** — the anti-dead-button ledger.

## Screen build status

24 screens are registered in `MASTER.md` §4. Built: 3 of 24.

| Screen ID | Name | Status | Phone | Tablet | Desktop | Note |
|---|---|---|---|---|---|---|
| `WF-HOME-01` | Home | BUILDING | — | — | — | Phase 0 |
| `WF-SELL-01` | Sell | BUILDING | no | no | yes | Exists as `pages/Till.jsx`; renamed to Sell in Phase 0 |
| `WF-PRODUCT-01` | Product/variant sheet | PLANNED | | | | Phase 1 |
| `WF-CUST-01` | Customer quick sheet | PLANNED | | | | Phase 3 |
| `WF-PAY-01` | Payment | BUILDING | no | no | yes | `components/PaymentPanel.jsx`, cash only |
| `WF-PAY-02` | Payment needs checking | PLANNED | | | | Phase 2 — P0 even before provider integration |
| `WF-SUCCESS-01` | Sale success | BUILDING | no | no | yes | `components/Receipt.jsx` |
| `WF-ORDERS-01` | Orders | PLANNED | | | | Phase 5 |
| `WF-ORDER-02` | Order detail | PLANNED | | | | Phase 5 |
| `WF-SALES-01` | Sales / Bills | PLANNED | | | | Phase 1 — P0 |
| `WF-SALE-02` | Bill detail | PLANNED | | | | Phase 1 |
| `WF-RETURN-01` | Return | PLANNED | | | | Phase 6 |
| `WF-EXCHANGE-01` | Exchange | PLANNED | | | | Phase 6 |
| `WF-HELD-01` | Held bills | PLANNED | | | | Phase 5 |
| `WF-CUSTOMERS-01` | Customers | PLANNED | | | | Phase 3 |
| `WF-CUSTOMER-02` | Customer detail | PLANNED | | | | Phase 3 |
| `WF-SHIFT-01` | Shift | PLANNED | | | | Phase 7 |
| `WF-CASH-01` | Cash movement | PLANNED | | | | Phase 7 |
| `WF-DAY-01` | Day close | PLANNED | | | | Phase 7 |
| `WF-REPORTS-01` | Reports | PLANNED | | | | Phase 9 |
| `WF-MORE-01` | More | BUILDING | — | — | — | Phase 0 |
| `WF-SYNC-01` | Sync status | PLANNED | | | | Phase 11 |
| `WF-SETTINGS-01` | Settings | PLANNED | | | | Phase 0 stub, Phase 4 real |
| `WF-DEVICES-01` | Counters/devices | PLANNED | | | | Phase 10 |
| `WF-INTEGRATIONS-01` | Integrations | PLANNED | | | | Phase 12 |

## Navigation

```text
HOME | SELL | ORDERS | CUSTOMERS | MORE
```

Fixed at five. `MASTER.md` §16.2. Adding a sixth needs product approval recorded in `CHANGELOG.md`.

**Phone:** bottom bar, thumb-reachable, five icons with labels.
**Tablet:** bottom bar, wider targets, more context visible per screen.
**Desktop/counter:** left rail, and the nav must never take keyboard focus away from the Sell
search box — see the focus rule below.

## The focus rule (desktop)

A barcode scanner is a keyboard. It types into whatever holds focus. So on `WF-SELL-01`:

- the search box holds focus at all times,
- it takes focus back after every add, every sheet close and every error,
- nav, buttons and tiles must not steal it on mouse-over or on render.

A scan that lands in a nav element is a scan the cashier does not notice losing. This is why
`MASTER.md` §1 commandment 10 exists: mobile simplicity must not slow the counter down.

## Link integrity — Phase 0 scope

Every action registered below either navigates to a listed screen, opens a listed sheet, or is
disabled with a visible reason. **No dead buttons.**

| From | Action | Goes to | Live? |
|---|---|---|---|
| `WF-HOME-01` | New Sale | `WF-SELL-01` | Phase 0 |
| `WF-HOME-01` | Today sales tile | `WF-SALES-01` | Phase 1 — disabled with reason until then |
| `WF-HOME-01` | Orders needing attention | `WF-ORDERS-01` | Phase 5 — tile hidden, not faked |
| `WF-HOME-01` | Shift status | `WF-SHIFT-01` | Phase 7 — tile hidden, not faked |
| `WF-HOME-01` | Activity row | `WF-SALE-02` | Phase 1 |
| Nav | Home / Sell | those screens | Phase 0 |
| Nav | Orders / Customers | registered empty state naming the phase | Phase 0 |
| Nav | More | `WF-MORE-01` | Phase 0 |
| `WF-MORE-01` | Settings / Sales / Shift / Reports / Sync | their screens | per phase, each showing an honest state |
| `WF-SELL-01` | Continue | `WF-PAY-01` | built |
| `WF-PAY-01` | Complete sale | `WF-SUCCESS-01` | built |
| `WF-SUCCESS-01` | Print | system print | built |
| `WF-SUCCESS-01` | New sale | `WF-SELL-01` | built |

### Empty states for unbuilt tabs

Orders and Customers are in the fixed five from day one, but their features arrive in Phases 5
and 3. Until then each tab is a **registered screen with an honest empty state** naming what it
will do — not a hidden tab and not a dead button.

This is recorded rather than assumed, because it is a visible product compromise: a shop opening
the app in Phase 0 will see two tabs that do not yet do anything.
