# CONTRACTS

Module, API, event and permission contracts. `MASTER.md` §7 and §8 hold the canonical lists; this
file holds **what must not be lost** — the rules that already cost someone something to learn, and
the current API surface.

---

# 1. Rules that survive every simplification pass

These are not UX decisions and a simplification pass must not soften them. Each is carried forward
from the superseded spec (CHG-004) with its reason intact.

## 1.1 The four limited things

A sale in Inventory today is **one transaction across six ledgers**
(`counter-sale.service.ts:103`). The POS has its own database, so that single commit is gone, and
four things in it can be spent twice.

| What is limited | Can a cache answer? | Rule |
|---|---|---|
| A capped offer ("first 50") | Yes — rules + stock | Reserve before commit |
| The last few of a variant | Yes — above the hold threshold, sell optimistically | Reserve at or below the threshold |
| Customer's loyalty points | **Never** | **Always** a live hold |
| Customer's store credit | **Never** | **Always** a live hold |

The last two are the ones that cost real money. Inventory guards both with `SELECT ... FOR UPDATE`
on the customer row plus a balance guard in the same statement
(`store-credit.service.ts:33`, `loyalty.service.ts:159`). A balance moves from outside the till —
a colleague processing the same customer's exchange is enough — so the cached number is precisely
the one that is wrong.

**An oversold offer costs a discount. The same ₹2,000 of store credit spent twice is the shop's own
money out of the door twice.**

If the line is down: offer the other payment methods and say plainly that points and credit need a
connection. Never fall back to the cache.

> Reporting a redemption *after* the sale does not fix the capped-offer case either. By then the
> money is taken and the bill printed. `redemption.service.ts:16` writes the limit check **into**
> the UPDATE for exactly this reason.

## 1.2 Money

Integer paise everywhere. Never float, never Decimal-as-float.

GST comes back **out** of the shelf price, and the tax is a **subtraction**:

```text
net  = round(gross * 100 / (100 + rate))
tax  = gross - net          <- subtraction, never its own rounded sum
cgst = ceil(tax / 2)        <- the odd paisa, fixed side, every time
sgst = tax - cgst
```

Round both independently and a bill whose lines are each right has a total a paisa out. The
subtraction makes `net + tax = gross` true by construction.

The round-off is **its own line**, never absorbed: `charged = bill + round-off`, always. That is
what lets the day book reconcile.

## 1.3 Invoice numbering

Unbroken, per financial year, per shop, never reused, never skipped, allocated **inside the same
transaction that saves the sale**. The increment IS the read
(`UPDATE ... SET last_number = last_number + 1 ... RETURNING`). Credit notes have their own series.

A gap is a question the shop answers to a tax officer.

## 1.4 Idempotency

The public API's `Idempotency-Key`, the till's own retry, and the offline outbox flush are **three
names for one problem**. One mechanism: a unique `onceKey`, `ON CONFLICT DO NOTHING`, second
attempt returns the first answer.

Same key + same basket → the first sale.
Same key + different basket → refused, naming the invoice already made.
Lost race on the constraint → find the winner and return it. Losing is not an error.

**The key belongs to the basket, not to the button.** A key made when Complete is pressed is a new
key on every press. A key made on component mount is a new key after every reload. It is created
when the basket starts, saved with it, and discarded when the sale is saved.

## 1.5 Historical facts are frozen

Description, HSN, unit price, tax rate **and the CGST/SGST/IGST split as charged** are copied onto
the sale line. A bill must read the same in five years after the item is renamed, re-priced or
deleted — and a reprint from a newer build must not disagree with the original because an
odd-paisa rule changed.

## 1.6 No raw errors, ever

Every expected error answers three things: what happened, **is my work safe**, what next.

```text
Bad:  409 HOLD_CONFIRMATION_FAILED
Good: Stock confirmation is taking longer than usual. Your sale is safe. We'll keep trying.
```

Never expose `outbox`, `idempotency`, `holdId`, `Gateway`, webhook status, stack traces or internal
UUIDs to a store user. Anything not thrown deliberately is logged in full and replaced.

A route that has already started writing a response cannot be rescued by the error handler, so it
catches its own.

## 1.7 Never ask for money twice

An ambiguous provider result is **not** a failure. Never treat it as one and ask the customer to
pay again. It goes to `WF-PAY-02` needs-checking. `POS-PAY-010`, P0, before any provider
integration exists.

## 1.8 Returns (Phase 6)

- **A returned piece is worth what was paid for it on that bill**, after its share of any discount
  -- never today's tag. Worked out cumulatively, so a line returned piece by piece adds to exactly
  the line; the bill's round-off comes back with the last piece. Every credit note for a bill
  together equals what was paid.
- **Nothing on a bill is ever edited or deleted.** A credit note beside it is the only correction.
- **Money goes back as money only up to what was paid in money** (less money already refunded).
  Store credit and exchange credit come back as store credit. Otherwise returning a saree bought
  with credit turns credit into cash, and "exchange then return" turns a no-cash-refund exchange
  into a cash refund. *This is a product rule chosen in Phase 6 -- decision #8 asks the owner to
  confirm or overturn it.*
- **No refund while a payment is being checked or money is owed.** Refunding money that may never
  have arrived pays it out twice.
- **The bill row is locked** before "how many are left" is read. Same pattern as collecting a
  balance (Phase 5).

---

# 2. Current API surface

Base `/api/v1`. Version in the path from the first commit.

| Method | Path | Service | Actor | Status |
|---|---|---|---|---|
| GET | `/health` | `services/health` | none | live |
| GET | `/shop` | `services/shop` | dev | live |
| GET | `/sales/items?q=` | `services/items` | dev | live |
| POST | `/sales` | `services/sale` | dev | live |
| GET | `/sales/:id` | `services/sale` | dev | live |
| GET | `/home/summary` | `services/home` | dev | Phase 0 |
| GET | `/returns/bill/:saleId` | `services/returns` | dev | Phase 6 -- what can come back, window, approval needed, money cap |
| POST | `/returns/bill/:saleId/quote` | `services/returns` | dev | Phase 6 -- exact refund for a selection; writes nothing |
| POST | `/returns/bill/:saleId` | `services/returns` | dev | Phase 6 -- record a return; idempotent on `onceKey` |
| POST | `/returns/bill/:saleId/exchange` | `services/returns` | dev | Phase 6 -- return + new bill; new bill's key is `onceKey:sale` |
| GET | `/returns/:id` | `services/returns` | dev | Phase 6 -- one credit note |

This table lists Phase 0 and Phase 6. Phases 1-5 routes are in `src/routes/*.routes.ts`, each
documented where it is declared; they are not repeated here to avoid a second copy that drifts.

**Every service function takes an `Actor` as its first argument. No service function reads a
request or a session.** `types/actor.ts`. This is what makes the public API a key check in front of
existing functions rather than a rewrite — `MASTER.md` §3 hard boundary.

`devActor` currently stands in for sign-in and **refuses to run in production**, checked inside the
middleware itself so it cannot be mounted wrongly.

---

# 3. Events

Canonical minimums are in `MASTER.md` §7. None are produced yet; the outbox tables exist.

| Event | Phase | Schema ready |
|---|---|---|
| `sale.completed` | 8 | tables yes, producer no |
| `sale.returned` | 8 | |
| `sale.exchanged` | 8 | |
| `customer.created` / `customer.updated` | 3 | |
| `payment.updated` | 5 | |
| `order.status_changed` | 5 | |
| `day.closed` | 7 | |

## Webhook delivery rules — ported, not designed

`WebhookEndpoint` / `WebhookEvent` / `WebhookDelivery` are ports of Inventory's Storefront tables.
Inventory's **first** outbox read one global URL for every tenant, carried no client id, and
claimed rows before checking it had somewhere to send them — **747 events are still stranded**.
Four fields prevent that repeat:

| Field | Why |
|---|---|
| `sequence` | Monotonic per client. Timestamps cannot order two events in the same millisecond, and clocks move |
| `eventVersion` | Public contract. An old integration must not break when the payload grows |
| `lockedAt` | A lease. A claim older than it means the worker died mid-send, so the row is reclaimed rather than stranded. **This column IS the 747** |
| public identity | Invoice number and item code, never internal UUIDs — those would couple every client's database to our primary keys |

Signing is HMAC over `timestamp + "." + rawBody`, not the body alone. Without the timestamp inside
the signed material it is "a bearer token wearing a signature's name" and a captured request
replays forever.

---

# 4. Gateway

RS256 assertions, audience `pos`, copied from Inventory's `verifyGatewayAssertion`.

**The Gateway proves who someone is. This database decides what they may do at a till.** Permissions
are not fetched per request — a till must keep selling when the line is slow, and 150 ms is the
whole budget.

> `ApiKeyPermission` in the Gateway has exactly four values — READ, WRITE, DELETE, ADMIN — so it
> **cannot** express "may push items but may not read sales". Do not lean on it for scoping and do
> not add values: it is a shared database enum, and adding to one took Inventory's alerts endpoint
> down on 23 Sep 2026. Real scoping is `ApiKeyModuleAccess` / `ApiKeyMicroserviceAccess`, which are
> join tables.

---

# 5. Permissions

Baseline in `MASTER.md` §8. **Rows, not database enums** — adding a permission must not need a
migration against a table another deployment is reading.

Keys live in `types/actor.ts` so a typo is a compile error rather than a silently ungated action.

Cost and profit are **not a core POS capability at any role**, per `MASTER.md` §16.11. The `Item`
table has no cost column at all, which is the strongest form of that rule: it cannot leak what it
does not hold.

---

# 6. Known schema gaps

Found in the 2026-09-27 preflight. Each belongs to its phase; none is silently dropped.

| Gap | Needed by | Phase |
|---|---|---|
| ~~`Payment.status` for ambiguous/needs-checking~~ | POS-PAY-010, -011 | 2 — **closed** |
| Cash movement model (in/out, reason, actor) | POS-SHIFT-003, -004 | 7 |
| ~~Approval record (requester, approver, reason)~~ | POS-APR-001..005 | 4 — **closed** |
| Order collection date, notes, user-facing status | POS-ORD-004, -005, -006..009 | 5 |
| ~~Reprint / duplicate marking~~ | POS-RCPT-004 | 1 — **closed** |
| ~~`Item.imageUrl`~~ | POS-SELL-007 | 1 — **closed** |
