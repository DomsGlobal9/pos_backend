# POS ⇄ Inventory contract — v1 (draft for the Inventory session)

Status: **v1 AGREED between the two sessions, 2026-09-27** (answers folded in, §7). Q1 is recorded
for the owner to confirm (POS CHANGELOG #11).

Previously: DRAFT, 2026-09-27. Written by the POS session; Inventory's side to be built by the
Inventory session against it. Neither session commits in the other's repo. Changes to this file
are agreed in chat first, then written here.

Authority: `MASTER.md` §3 (ownership, hard boundaries), §7 (cross-module contracts, canonical
events). Nothing here overrides those; it makes them concrete.

---

## 0. The rules this contract exists to keep

1. **The POS never touches Inventory's database.** Everything below is HTTP to Inventory.
2. **The POS is the authority for the BILL** — prices charged, discounts, tax, payments, invoice
   and credit-note numbers. Inventory records what the POS sends and **never re-prices it**.
3. **Inventory is the authority for STOCK** — how many exist, where, and holds on them.
4. **Public identities only.** Items by `variantCode` (or SKU / barcode); bills by invoice and
   credit-note numbers. No uuid from either side crosses the wire.
5. **Every write is safe to repeat.** The POS delivers at-least-once; Inventory applies once.
6. **Inventory being slow or down never stops a sale.** The POS decides what to do (§6); Inventory
   only has to answer honestly and quickly.

---

## 1. Auth and scope

- One **POS connection** per tenant, StorefrontConnection-style: `credentialHash` + non-secret
  prefix, status, `locationIds`.
- For v1 a POS connection is scoped to **exactly one location** — the shop the till is in. (A
  counter-to-location map is a later version; say so if one location is wrong for any tenant.)
- Header: `X-Storefront-Key: <credential>` or `Authorization: Bearer <credential>` — the existing
  middleware, unchanged.
- The POS stores the credential encrypted; it is entered once by the owner, never by a cashier.

Base path (built, Inventory commit fc4929c): **`/api/v1/pos/v1`** — so `GET /api/v1/pos/v1/catalogue`,
`GET /api/v1/pos/v1/stock`, `POST /api/v1/pos/v1/events`. Below, paths are written short (`/pos/catalogue`
means `/api/v1/pos/v1/catalogue`). Credentials are `sk_<prefix>_<secret>`. The POS derives the address
from `INVENTORY_BASE_URL` (Inventory's root) + `/api/v1/pos/v1`.

---

## 2. Catalogue — `GET /pos/catalogue`

The storefront feed (`GET /products`, same cursor and `since` semantics) **plus**, per variant:

| Field | Type | Why |
|---|---|---|
| `hsn` | string or null | `Product.hsnCode` — every POS bill line prints it |
| `taxRateBps` | int | `Product.taxRateBps` — **the rate as the shop typed it**; the POS uses it as given and does not derive it from the price |
| `taxSlabbed` | bool | so the POS can WARN (never correct) when a stitched piece over Rs 2,500 is at 5% |
| `priceIsExclusive` | bool | the POS prices inclusive today; an exclusive product must be visible, not silently mis-billed |
| `pricePaise` | int | price at the connection's location, **in paise** (the storefront's rupee float is not acceptable for a bill) |
| `stock.available` | int | at the connection's location |
| `eligible` | bool | on incremental (`since`/cursor) pages, a product that became archived/unpublished must still appear once with `eligible:false`, so the POS can stop selling it. Omitting it means the till keeps a dead item forever |

Everything else as the storefront feed has it (images, colour, size, barcode, sku, variantCode,
productCode for grouping).

The POS maps: `variantCode → Item.code`, `barcode → Item.barcode`, `productCode → Item.variantGroup`,
`taxRateBps/100 → Item.taxRate` (the POS stores whole percent today; a fractional rate is refused
at sync with a clear message until the POS moves to basis points — tracked as pending decision #5).

## 3. Live stock — `GET /pos/stock?codes=A,B,…` (max 50)

`{ code, available, reserved, asOf }` per variant at the connection's location. Used by the POS to
decide whether a hold is needed and to show "as of" freshness. Cheap, read-only.

---

## 4. Events — `POST /pos/events`

> **AS BUILT (found by the first real end-to-end run, 27 Sep, 17/17 passing).** Inventory reads the
> event FLAT with `kind` -- not the `{ eventType, payload }` envelope sketched below -- takes tax as
> `taxRateBps`, names a return's bill `againstInvoiceNo` with each line's worth as `lineTotalPaise`,
> and answers `{ success, data: { answer, detail?, warnings?, orderNumber? } }`. The POS keeps its own
> canonical event in the outbox (a shop's software reads it in Phase 12) and translates to this
> dialect on the way out: `services/inventory-link/wire.ts`. Payments sent are the COLLECTED ones.
>
> **Open, both sides:** a `payment.updated` event -- a kept order's balance collected later, a UPI
> check resolved -- so Inventory's day book sees money that arrives after the sale.

One event per request (a batch endpoint can come later). Body is the POS outbox row as-is:

```json
{
  "eventType": "sale.completed" | "sale.returned" | "sale.exchanged",
  "eventVersion": 1,
  "sequence": 1234,
  "payload": { ... see below ... }
}
```

The POS sends **one event at a time, per tenant, in `sequence` order**. A sale therefore always
reaches Inventory before a return against it.

### 4.1 `sale.completed`

Payload (already written by the POS, `services/events`):
`invoiceNo, financialYear, occurredAt, counter, cashier, kind (COMPLETE|KEPT), fulfilment,
customerRef (E.164 phone or null), lines[{itemCode, description, hsn, qty, unitPricePaise,
discountPaise, taxRate, taxPaise, lineTotalPaise}], totals{…}, payments[{method, amountPaise, status}]`.

Inventory:
- writes a SalesOrder with `sourceSystem = 'SCALEEZY_POS'`, `externalOrderId = invoiceNo`
  (`uq_external_order` makes a repeat safe), with the **POS's amounts as given**
- dispatches it at the connection's location in the same transaction (the proven
  `writeFullOrderInTransaction + dispatchInTransaction` path)
- a `KEPT` sale is dispatched too: the pieces are the customer's from the moment it is kept, even
  while they are still in the shop
- a line with `itemCode: null` (an item the POS has that Inventory does not) is recorded with no
  stock movement

**Money (Q1, agreed provisionally; owner to confirm).** Inventory DOES record POS payments, so its
day book -- the owner's "what did the business take today" across every channel -- keeps counting
counter takings after the cut-over. The POS day close answers a different question ("is the drawer
right?"). Both show the same money; the day book must show it on a **per-channel line** (POS,
online, Shopify) so nobody adds the two documents together. If the owner prefers POS payments
excluded, Inventory makes that a setting.

`sale.completed` also carries `customer: { name, phone }` (Q6). Inventory applies its
`phoneForOutsideCustomer` rule: a number already on another customer is dropped and the order is
saved without it. That is correct, not a failure; the POS does not treat it as a mismatch.

### 4.2 `sale.returned`

`creditNoteNo, originalInvoiceNo, occurredAt, reason, customerRef, lines[{itemCode, description,
hsn, qty, taxRate, amountPaise, taxPaise}], totals{totalPaise, taxPaise, roundOffPaise},
refunds[{method, amountPaise}]`.

Inventory books a return against the order whose `externalOrderId = originalInvoiceNo`, restocks
the lines at the connection's location, **idempotent on `creditNoteNo`**. Same rule on money as 4.1.

**Amounts are CHECKED, not taken (Q3).** Inventory computes each returned line's worth from its own
copy of the sale (proportional, aware of earlier returns) and refuses with `AMOUNT_MISMATCH` when a
line differs from the POS's `amountPaise` by more than one paisa.

- Compare **per line**, not the total. The POS adds the original bill's round-off to the credit
  note that empties the bill (`totals.roundOffPaise`, never inside a line), so totals legitimately
  differ by up to 50 paise on the last return.
- The POS's rule is cumulative: pieces `from..to` of a line of `qty` that came to `T` are worth
  `round(T*to/qty) - round(T*from/qty)`, with `round` = half away from zero (JS `Math.round` on a
  non-negative value). `portionOf` must agree to the paisa or every partial return will stop the
  queue. Test it against the POS's own sweep in `src/scripts/verify-returns.ts` (4,300 lines).

### 4.3 `sale.exchanged`

`creditNoteNo, originalInvoiceNo, newInvoiceNo, occurredAt, reason, counter, customerRef,
returned[…as 4.2 lines], taken[…as 4.1 lines], creditPaise, newTotalPaise, differencePaise,
payments[…], refunds[…]`.

**One Inventory transaction:** the return of `returned` against `originalInvoiceNo` AND a new order
for `taken` with `externalOrderId = newInvoiceNo`, dispatched. Idempotent on `creditNoteNo`. The
POS never sends a separate `sale.completed` for `newInvoiceNo` — handling this event as a return
plus a sale is the whole of it.

### 4.4 Answers

| Status | Body `details.code` | POS does |
|---|---|---|
| 200 | `APPLIED` or `ALREADY_APPLIED`, optionally `warnings: string[]` | marks delivered; keeps the warnings (last 30) for the owner's Inventory link screen |
| 400/422 | `UNKNOWN_ITEM` (with `itemCode`), `UNKNOWN_ORDER` (with `invoiceNo`), `BAD_PAYLOAD` | stops that tenant's queue and shows the owner (not a cashier) one plain sentence; a person fixes it and retries |
| 401/403 | — | stops, tells the owner the connection needs a new key |
| 409 | `QTY_EXCEEDS_SOLD` (return of more than was dispatched) | as 400 |
| 409 | `AMOUNT_MISMATCH` (with `itemCode`, `posPaise`, `inventoryPaise`) | as 400 |
| 429 / 5xx / timeout | — | retries with backoff (30 s → 2 min → 10 min → 1 h, then hourly), same event, never reordered |

"Stops that tenant's queue" is deliberate: delivering a return whose sale failed would be wrong,
so a permanent failure holds everything behind it until a person looks.

---

### 4.5 Three rules settled after the first real sales (27 Sep, Inventory commits 848811e, e0ca93a)

1. **A sale needs no customer.** A customer-less sale goes to one per-shop walk-in customer
   (externalId `POS:WALK-IN`, named "Walk-in customer (no details taken)", never a phone), found
   or created on first use. A phone that is sent goes through `phoneForOutsideCustomer`.
2. **The till's GST is stored as sent** (`taxRate` / `taxPaise` per line) -- the POS bill is the
   legal document. Inventory computes its own only as a check and answers with a **warning**, never a
   refusal, when they differ.
3. **An event describing something that already happened never fails on stock.** A sale (or an
   exchange's `taken` lines) of more than Inventory thinks it has is recorded, stock goes
   **negative**, and a warning says by how much. Negative stock is the honest record of a count that
   was wrong; a stopped queue behind a sale that already happened could never clear. Same rule as the
   POS's own count.

Warnings are plain sentences, each starting with the item code.

## 5. Holds — the genuinely new part

Needed because `InventoryReservation` requires a sales-order item (no hold before an order exists)
and **nothing sweeps `expiresAt` today**, so a hold would never expire. Decided (Q5): **a holds
table of its own**, not an FK relaxation, plus the sweeper -- which will be the first code ever to
honour an `expiresAt` in Inventory. **This is the part that needs a
migration on the shared production database, run by the user.**

| Call | Body | Answer |
|---|---|---|
| `POST /pos/holds` | `{ holdKey, itemCode, qty, ttlSeconds }` (`ttlSeconds` ≤ 900) | 201 `{ holdId, expiresAt, available }` or 409 `NOT_ENOUGH` `{ available }`. Idempotent on `holdKey` (the POS's basket once-key + line) |
| `POST /pos/holds/:holdId/confirm` | `{ invoiceNo }` | 200. Idempotent. The later `sale.completed` for that invoice consumes the hold instead of reserving again |
| `POST /pos/holds/:holdId/release` | — | 200. Idempotent; releasing an expired or already-released hold is 200, not an error |

The POS only asks for a hold when its cached count is at or below the shop's threshold
(`ShopSettings.holdThresholdQty`, default 3) — the last few pieces. Above that it sells
optimistically. It waits **at most 1.5 s** for an answer (§6).

`sale.completed` will carry `holds: [{ holdId, itemCode }]` for lines that had one.

---

## 6. What the POS does when Inventory is slow or down

Not Inventory's work, written here so both sides know:

- Selling never waits on Inventory. The sell screen reads the POS's own item cache.
- The event queue simply waits and retries; nothing is lost (outbox, same transaction as the bill).
- A hold that does not answer in 1.5 s: the shop's setting decides — **sell anyway and flag** (the
  default) or **ask the cashier to check the shelf**. Never a frozen screen.
- The cashier sees one line in words ("Stock can't be checked right now — the sale is saved"),
  never a status code. The owner sees queue problems on a settings screen.

---

## 7. Questions, and the answers agreed 27 Sep

- Q1 -> POS payments ARE recorded in Inventory, shown per channel in the day book (§4.1). Owner to
  confirm (POS CHANGELOG #11).
- Q2 -> Yes, `invoiceNo` -- the FULL formatted number (`INV/2026-27/0012`, `CN/...`), never the bare
  integer, or two series would collide inside `uq_external_order` and a replay would return the
  wrong order.
- Q3 -> Inventory computes and compares per line; `AMOUNT_MISMATCH` stops the queue (§4.2).
- Q4 -> One location per connection is fine; `locationIds` stays an array for later.
- Q5 -> Holds get their own table plus the sweeper; one migration, run by the user.
- Q6 -> Send `customer: { name, phone }`; the outside-customer phone rule applies (§4.1).

The original questions:

- **Q1** Money: agree that POS payments are NOT posted as takings in Inventory's day book (§4.1)?
- **Q2** Is `invoiceNo` acceptable as `externalOrderId` (it is unique per tenant in the POS and is
  the public identity), rather than the POS's internal sale id?
- **Q3** Returns: which of Inventory's return paths fits a return that arrives as a finished credit
  note (the POS already decided the amounts) — does `completeReturnIn` accept given amounts?
- **Q4** One location per POS connection for v1 — fine for current tenants?
- **Q5** Holds: FK relaxation or a new table — your call; the POS only needs the three calls above.
- **Q6** Does `sale.completed` need anything else for `writeFullOrderInTransaction` that is not in
  the payload (e.g. a customer record by phone)?

---

## 8. Migrations

| Part | Needs a migration on the shared production DB? |
|---|---|
| Catalogue fields | No — `hsnCode`, `taxRateBps`, `taxSlabbed`, `priceIsExclusive` exist |
| Event intake | Probably no — `sourceSystem` is a plain string column and `uq_external_order` exists. To confirm for returns (Q3) |
| Holds | **Yes.** Planned, and run by the user — never discovered mid-phase |
| POS connection | Probably no if StorefrontConnection is reused as-is; yes if it needs a `kind` column |

Any enum change must follow the shared-DB enum rule: a value added to a shared enum breaks the
deployed build reading it. Prefer strings.
