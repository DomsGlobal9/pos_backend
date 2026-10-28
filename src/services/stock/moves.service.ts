import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { record } from '../audit';

/**
 * A STANDALONE SHOP'S STOCK, BY HAND (28 Oct). The count already moves with every bill (stock.service).
 * What a shop without Inventory could not do was the rest of a stock book:
 *
 *   RECEIVED  a parcel came in: +12, with the supplier or bill in the note
 *   ADJUSTED  damaged, lost, found, sent back to the supplier -- a reason is required
 *   COUNTED   "there are 7 on the shelf": the till works out the difference
 *
 * Each is one row in stock_moves with the count before and after and who did it, so "why does it say
 * 3?" has an answer. Before this, a new parcel meant overwriting the number on the item form, and the
 * old figure, and the reason, were gone.
 *
 * Owner only, like the item list. Refused for a shop connected to Inventory: its stock is kept there,
 * and two stock books for one shop is how they stop agreeing.
 */

export const KINDS = ['RECEIVED', 'ADJUSTED', 'COUNTED'] as const;
export const REASONS: Record<string, string> = {
  DAMAGED: 'Damaged', LOST: 'Lost or stolen', FOUND: 'Found', TO_SUPPLIER: 'Sent back to the supplier', OTHER: 'Other'
};
const MOST = 100_000;

function mustManage(actor: Actor) {
  if (!may(actor, PERMISSIONS.SETTINGS)) throw forbidden('Only the owner can change stock.', { code: 'NOT_PERMITTED' });
}
async function mustBeStandalone(clientId: string) {
  const link = await prisma.inventoryLink.findUnique({ where: { clientId }, select: { connected: true } });
  if (link?.connected) throw conflict('This shop\'s stock is kept in Inventory. Receive and count it there.', { code: 'FROM_INVENTORY' });
}

export async function moveStock(actor: Actor, code: string, input: { kind: string; qty: number; reason?: string | null; note?: string | null }) {
  mustManage(actor);
  await mustBeStandalone(actor.clientId);
  const kind = String(input.kind ?? '');
  if (!KINDS.includes(kind as any)) throw badRequest('Choose received, adjusted or counted.', { code: 'BAD_KIND' });
  const qty = Number(input.qty);
  if (!Number.isInteger(qty) || Math.abs(qty) > MOST) throw badRequest('Type a whole number of pieces.', { code: 'BAD_QTY' });
  const note = (input.note ?? '').trim().slice(0, 200) || null;
  let reason: string | null = null;
  if (kind === 'RECEIVED' && qty <= 0) throw badRequest('Type how many pieces came in.', { code: 'BAD_QTY' });
  if (kind === 'COUNTED' && qty < 0) throw badRequest('A count cannot be below nothing.', { code: 'BAD_QTY' });
  if (kind === 'ADJUSTED') {
    if (qty === 0) throw badRequest('Type how many pieces to add or take off.', { code: 'BAD_QTY' });
    reason = String(input.reason ?? '');
    if (!REASONS[reason]) throw badRequest('Say why: damaged, lost, found, sent back, or other.', { code: 'BAD_REASON' });
    if (reason === 'OTHER' && !note) throw badRequest('Write a few words on why.', { code: 'NOTE_NEEDED' });
    // Found is pieces coming back; damaged, lost and sent back are pieces going out. The sign follows.
    if (reason === 'FOUND' && qty < 0) throw badRequest('Found pieces are added: type a number above 0.', { code: 'BAD_QTY' });
    if (['DAMAGED', 'LOST', 'TO_SUPPLIER'].includes(reason) && qty > 0) input = { ...input, qty: -qty };
  }

  const moved = await prisma.$transaction(async (tx) => {
    // Locked, so a sale in the same second cannot read the count between "before" and "after".
    const rows = await tx.$queryRaw<{ id: string; cached_qty: number | null; name: string }[]>`
      SELECT id, cached_qty, name FROM items WHERE client_id = ${actor.clientId} AND code = ${code} FOR UPDATE`;
    const item = rows[0];
    if (!item) throw notFound('No item with that code.');
    const before = item.cached_qty;
    const after = kind === 'COUNTED' ? qty : (before ?? 0) + Number(input.qty);
    const delta = after - (before ?? 0);
    await tx.item.update({ where: { id: item.id }, data: { cachedQty: after, cachedQtyAt: new Date() } });
    const move = await tx.stockMove.create({
      data: { clientId: actor.clientId, itemId: item.id, kind, delta, qtyBefore: before, qtyAfter: after, reason, note, byId: actor.id, byName: actor.name ?? null }
    });
    return { move, name: item.name, before, after, delta };
  });

  await record(actor, {
    action: kind === 'RECEIVED' ? 'stock.received' : kind === 'ADJUSTED' ? 'stock.adjusted' : 'stock.counted',
    subject: code,
    detail: { name: moved.name, delta: moved.delta, qtyBefore: moved.before, qtyAfter: moved.after, ...(reason ? { reason } : {}), ...(note ? { note } : {}) }
  });
  return { code, name: moved.name, qtyBefore: moved.before, qty: moved.after, delta: moved.delta, ...(moved.before === null && kind !== 'COUNTED' ? { note: 'The count was not known before; it starts from this.' } : {}) };
}

/** An item's stock book, newest first: what a person changed. Sales and returns are on their bills. */
export async function stockHistory(actor: Actor, code: string) {
  mustManage(actor);
  const item = await prisma.item.findUnique({ where: { clientId_code: { clientId: actor.clientId, code } }, select: { id: true, name: true, cachedQty: true } });
  if (!item) throw notFound('No item with that code.');
  const moves = await prisma.stockMove.findMany({ where: { clientId: actor.clientId, itemId: item.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  // Pieces sold since the last change by hand: what explains the gap between "after" and the count now.
  const last = moves[0]?.createdAt;
  const sold = last ? await prisma.saleLine.aggregate({
    where: { itemId: item.id, sale: { clientId: actor.clientId, createdAt: { gt: last } } } as any, _sum: { qty: true }
  }).catch(() => null) : null;
  return {
    code, name: item.name, qty: item.cachedQty,
    soldSinceLastChange: (sold as any)?._sum?.qty ?? 0,
    moves: moves.map(m => ({
      at: m.createdAt, kind: m.kind, delta: m.delta, qtyBefore: m.qtyBefore, qtyAfter: m.qtyAfter,
      reason: m.reason, reasonLabel: m.reason ? REASONS[m.reason] ?? m.reason : null, note: m.note, by: m.byName
    }))
  };
}

export async function setLowStockAt(actor: Actor, value: number) {
  mustManage(actor);
  if (!Number.isInteger(value) || value < 0 || value > 1000) throw badRequest('Type a number of pieces, 0 to 1000.');
  await prisma.shopSettings.update({ where: { clientId: actor.clientId }, data: { lowStockAt: value } });
  return { lowStockAt: value };
}

/** Written by the item form (import.service saveItem) when the count typed there differs: kept in the book too. */
export async function noteFormCount(actor: Actor, itemId: string, before: number | null, after: number | null, isNew: boolean) {
  if (after === null || after === before) return;
  await prisma.stockMove.create({
    data: { clientId: actor.clientId, itemId, kind: isNew ? 'OPENING' : 'ITEM_FORM', delta: after - (before ?? 0), qtyBefore: before, qtyAfter: after, byId: actor.id, byName: actor.name ?? null }
  });
}
