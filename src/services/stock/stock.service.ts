import { Prisma } from '@prisma/client';

/**
 * The POS's own idea of how many are left. POS-INV-003, POS-STAND-001.
 *
 * `Item.cachedQty` is ADVISORY. It lets an assistant say "last one" honestly and it decides when a
 * hold is worth asking Inventory for (Phase 8). It is never the authority and it never blocks a
 * sale -- a count is a guess, and the piece may be in the customer's hand already.
 *
 * Before this existed the figure was set once and never moved, so the till said "4 left" of a
 * saree that had sold out on Tuesday. Now a sale takes the pieces off and a return puts them back,
 * in the same transaction as the bill.
 *
 *   STANDALONE  this IS the shop's stock count -- there is nothing else
 *   CONNECTED   an estimate between refreshes from Inventory, which overwrite it
 *
 * An item whose count is unknown (null) stays unknown: subtracting from nothing does not produce
 * a number anyone should believe. The figure may go below zero -- that is the truth when the count
 * was wrong, and the screen shows it as "none left", not as a negative.
 *
 * ONE PASS, IN ONE ORDER. Changes are combined per item and applied sorted by id. Two sales that
 * touch the same two sarees in opposite orders would otherwise each lock one row and wait for the
 * other -- a deadlock, which Postgres breaks by failing one of the sales. An exchange (pieces back
 * AND pieces out) goes through here once, for the same reason.
 */

type Tx = Prisma.TransactionClient;

export interface StockChange {
  itemId: string | null;
  /** Negative: pieces left the shop. Positive: pieces came back. */
  delta: number;
}

export async function adjust(tx: Tx, clientId: string, changes: StockChange[]) {
  const net = new Map<string, number>();
  for (const c of changes) {
    if (!c.itemId || c.delta === 0) continue;
    net.set(c.itemId, (net.get(c.itemId) ?? 0) + c.delta);
  }
  for (const itemId of [...net.keys()].sort()) {
    const delta = net.get(itemId)!;
    if (delta === 0) continue;
    await tx.$executeRaw`
      UPDATE items SET cached_qty = cached_qty + ${delta}, cached_qty_at = now(), updated_at = now()
       WHERE id = ${itemId} AND client_id = ${clientId} AND cached_qty IS NOT NULL`;
  }
}

export const sold = (lines: { itemId: string | null; qty: number }[]): StockChange[] =>
  lines.map(l => ({ itemId: l.itemId, delta: -l.qty }));

export const cameBack = (lines: { itemId: string | null; qty: number }[]): StockChange[] =>
  lines.map(l => ({ itemId: l.itemId, delta: l.qty }));
