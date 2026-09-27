# FLOWS AND SCREEN REGISTRY

Journeys are in `MASTER.md` §5 and are not repeated here. This file tracks **which screens exist,
what they link to, and which links are live** — the anti-dead-button ledger.

## Screen build status

24 screens are registered in `MASTER.md` §4. Built: 15 of 24.

| Screen ID | Name | Status | Phone | Tablet | Desktop | Note |
|---|---|---|---|---|---|---|
| `WF-HOME-01` | Home | **DONE** | yes | yes | yes | Activity rows open the bill |
| `WF-SELL-01` | Sell | **DONE** | yes | yes | yes | `pages/Till.jsx`; full sale completed at 375px |
| `WF-PRODUCT-01` | Product/variant sheet | **DONE** | yes | yes | yes | Out-of-stock colours shown, not hidden |
| `WF-CUST-01` | Customer quick sheet | **DONE** | yes | yes | yes | Phone first; Skip is as prominent as Use |
| `WF-PAY-01` | Payment | **DONE** | yes | yes | yes | Cash, UPI, card, split. Sticky Complete on a 3-way split |
| `WF-PAY-02` | Payment needs checking | **DONE** | yes | yes | yes | The worklist that makes "not confirmed yet" safe to offer |
| `WF-SUCCESS-01` | Sale success | **DONE** | yes | yes | yes | Same component as `WF-SALE-02`, by design |
| `WF-ORDERS-01` | Orders | **DONE** | yes | yes | yes | Tab strip scrolls on a phone; the page never does |
| `WF-ORDER-02` | Order detail | **DONE** | yes | yes | yes | Take payment / Mark ready / Hand over |
| `WF-SALES-01` | Sales / Bills | **DONE** | yes | yes | yes | One search box for invoice, phone or name |
| `WF-SALE-02` | Bill detail | **DONE** | yes | yes | yes | Reprint with duplicate marking |
| `WF-RETURN-01` | Return | **DONE** | yes | yes | yes | Window and "a manager will need to approve" said before anything is chosen; refund figure from the server |
| `WF-EXCHANGE-01` | Exchange | **DONE** | yes | yes | yes | Same screen, second half: what goes out instead; "Customer pays Rs X" / "Give back Rs X" / "Even" |
| `WF-HELD-01` | Held bills | **DONE** | yes | yes | yes | A sheet on Sell, not under Orders -- a draft is not an order |
| `WF-CUSTOMERS-01` | Customers | **DONE** | yes | yes | yes | One box for a name or a number |
| `WF-CUSTOMER-02` | Customer detail | **DONE** | yes | yes | yes | No "View in CRM" until there is a CRM |
| `WF-SHIFT-01` | Shift | **DONE** | yes | yes | yes | Open with the float; the close is a blind count |
| `WF-CASH-01` | Cash movement | **DONE** | yes | yes | yes | A sheet on WF-SHIFT-01; cashier's cash out opens the manager sheet in place |
| `WF-DAY-01` | Day close | **DONE** | yes | yes | yes | Open shifts and payments to check first; closed day frozen, "since closing" apart |
| `WF-REPORTS-01` | Reports | **DONE** | yes | yes | yes | Period chips; a cashier sees their own day only. Export is Phase 12 (CSV) |
| `WF-MORE-01` | More | **DONE** | yes | yes | yes | Bills live; the rest disabled with a visible phase |
| `WF-SYNC-01` | Sync status | **DONE** | yes | yes | yes | `/sync`, from the header chip, More, the day close and the shift close. Waiting, needs a look, sent from this till |
| `WF-SETTINGS-01` | Settings | PLANNED | | | | Phase 0 stub, Phase 4 real |
| `WF-DEVICES-01` | Counters/devices | **DONE** | yes | yes | yes | Self-registered; manager names, places, sets paper. Also: `/r/:token` digital receipt (public, outside the shell) and Settings (UPI ID) |
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
| `WF-SUCCESS-01` | Print | system print, after counting the copy | built |
| `WF-SUCCESS-01` | New sale | `WF-SELL-01` | built |
| `WF-HOME-01` | Activity row | `WF-SALE-02` | built |
| `WF-MORE-01` | Bills | `WF-SALES-01` | built |
| `WF-SALES-01` | A bill row | `WF-SALE-02` | built |
| `WF-SALES-01` | Show older | next page, same screen | built |
| `WF-SALE-02` | All bills | `WF-SALES-01` | built |
| `WF-SALE-02` | Print again | system print, marked DUPLICATE | built |
| `WF-SALE-02` | Return / Exchange | `WF-RETURN-01` / `WF-EXCHANGE-01` | Phase 6 |
| `WF-SELL-01` | A grouped search row | `WF-PRODUCT-01` | built |
| `WF-PRODUCT-01` | A colour or size | back to `WF-SELL-01`, added | built |
| `WF-MORE-01` | Payments to check | `WF-PAY-02` | built |
| `WF-PAY-02` | It arrived / Never arrived | stays, row clears | built |
| `WF-PAY-02` | The invoice number | `WF-SALE-02` | built |
| `WF-SELL-01` | Add customer | `WF-CUST-01` | built |
| `WF-CUST-01` | Use / Add and use | back to `WF-SELL-01`, attached | built |
| `WF-CUST-01` | Skip | back to `WF-SELL-01`, no customer | built |
| Nav | Customers | `WF-CUSTOMERS-01` | built |
| `WF-CUSTOMERS-01` | A customer row | `WF-CUSTOMER-02` | built |
| `WF-CUSTOMER-02` | A recent bill | `WF-SALE-02` | built |
| `WF-CUSTOMER-02` | View in CRM | — | **absent until CRM exists** (CHG-007) |
| `WF-SALE-02` | The customer | `WF-CUSTOMER-02` | built |
| `WF-SELL-01` | More | the More sheet | built -- one primary action, the rest behind this |
| More sheet | Keep for customer | `WF-CUST-01` if no customer, then Keep sheet, then `WF-PAY-01` (advance) | built |
| More sheet | Park this bill | stays on `WF-SELL-01`, emptied | built |
| More sheet | Parked bills | `WF-HELD-01` | built |
| `WF-HELD-01` | A parked bill | back to `WF-SELL-01`, restored | built |
| Nav | Orders | `WF-ORDERS-01` | built |
| `WF-ORDERS-01` | An order | `WF-ORDER-02` | built |
| `WF-ORDER-02` | Take payment | `WF-PAY-01` (collect) | built |
| `WF-ORDER-02` | Hand over, money owed | the warning, then handed over | built |
| `WF-HOME-01` | Orders tile | `WF-ORDERS-01` | built -- was hidden until Phase 5 |
| `WF-CUSTOMER-02` | Owes ... on kept orders | `WF-ORDERS-01` | built |

### Empty states for unbuilt tabs

**All five tabs are live** as of Phase 5. The placeholder screen is now used only for unknown URLs.
