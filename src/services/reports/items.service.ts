import { SaleStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, forbidden } from '../../utils/httpError';
import { dayRange, todayString } from '../day-close';

/**
 * ITEM-WISE SALES (28 Oct). Before, the till showed its top ten sellers and nothing more: an owner
 * deciding what to buy again could not see the eleventh, nor which colour or size of a design sells.
 *
 * Every item sold in the period, one row each, with its colour, size and group: pieces sold and their
 * value, pieces back on credit notes made in the period, what is left, and the count on the shelf
 * now. A design's colours and sizes add up under its group. Values are as billed, GST included.
 *
 * The same bills as the sales report (completed, owing, returned -- never a held or cancelled one).
 * A line with no item (typed by hand) is listed under its description. The owner and managers only.
 */
const COUNTED: SaleStatus[] = ['COMPLETED', 'BALANCE_DUE', 'RETURNED'];
const MAX_DAYS = 366;

export interface ItemSalesRow {
  key: string; code: string | null; name: string; colour: string | null; size: string | null; group: string | null;
  soldQty: number; soldPaise: number; returnedQty: number; returnedPaise: number; netQty: number; netPaise: number; leftNow: number | null;
}

export async function itemSales(actor: Actor, q: { from?: string; to?: string } = {}) {
  if (!may(actor, PERMISSIONS.REPORTS)) throw forbidden('Item-wise sales are for the owner and managers.', { code: 'NOT_PERMITTED' });
  const from = q.from ?? todayString();
  const to = q.to ?? from;
  const a = dayRange(from);
  const b = dayRange(to);
  if (b.start < a.start) throw badRequest('The end date is before the start date.');
  if ((b.start.getTime() - a.start.getTime()) / 86_400_000 + 1 > MAX_DAYS) throw badRequest(`Choose ${MAX_DAYS} days or fewer.`);
  const inRange = { gte: a.start, lt: b.end };

  const [sold, back] = await Promise.all([
    prisma.saleLine.findMany({
      where: { sale: { clientId: actor.clientId, createdAt: inRange, status: { in: COUNTED } } },
      select: { itemId: true, description: true, qty: true, lineTotalPaise: true }
    }),
    prisma.returnLine.findMany({
      where: { returnRow: { clientId: actor.clientId, createdAt: inRange } },
      select: { qty: true, amountPaise: true, saleLine: { select: { itemId: true, description: true } } }
    })
  ]);

  const rows = new Map<string, ItemSalesRow>();
  const row = (itemId: string | null, description: string) => {
    const key = itemId ?? `typed:${description.trim().toLowerCase()}`;
    return rows.get(key) ?? rows.set(key, {
      key, code: null, name: description, colour: null, size: null, group: null,
      soldQty: 0, soldPaise: 0, returnedQty: 0, returnedPaise: 0, netQty: 0, netPaise: 0, leftNow: null
    }).get(key)!;
  };
  for (const l of sold) { const r = row(l.itemId, l.description); r.soldQty += l.qty; r.soldPaise += l.lineTotalPaise; }
  for (const l of back) { const r = row(l.saleLine.itemId, l.saleLine.description); r.returnedQty += l.qty; r.returnedPaise += l.amountPaise; }

  const ids = [...rows.keys()].filter(k => !k.startsWith('typed:'));
  const items = ids.length ? await prisma.item.findMany({
    where: { id: { in: ids }, clientId: actor.clientId },
    select: { id: true, code: true, name: true, colour: true, size: true, variantGroup: true, cachedQty: true }
  }) : [];
  for (const it of items) {
    const r = rows.get(it.id)!;
    Object.assign(r, { code: it.code, name: it.name, colour: it.colour, size: it.size, group: it.variantGroup, leftNow: it.cachedQty });
  }

  const list = [...rows.values()]
    .map(r => ({ ...r, netQty: r.soldQty - r.returnedQty, netPaise: r.soldPaise - r.returnedPaise }))
    .sort((x, y) => y.netPaise - x.netPaise || y.netQty - x.netQty || x.name.localeCompare(y.name));

  // A design's colours and sizes together: what to buy again is usually decided per design.
  const groups = new Map<string, { group: string; items: number; netQty: number; netPaise: number }>();
  for (const r of list) {
    if (!r.group) continue;
    const g = groups.get(r.group) ?? groups.set(r.group, { group: r.group, items: 0, netQty: 0, netPaise: 0 }).get(r.group)!;
    g.items++; g.netQty += r.netQty; g.netPaise += r.netPaise;
  }

  return {
    from, to,
    items: list,
    groups: [...groups.values()].sort((x, y) => y.netPaise - x.netPaise),
    totals: list.reduce((t, r) => ({ soldQty: t.soldQty + r.soldQty, soldPaise: t.soldPaise + r.soldPaise, returnedQty: t.returnedQty + r.returnedQty, returnedPaise: t.returnedPaise + r.returnedPaise, netQty: t.netQty + r.netQty, netPaise: t.netPaise + r.netPaise }),
      { soldQty: 0, soldPaise: 0, returnedQty: 0, returnedPaise: 0, netQty: 0, netPaise: 0 })
  };
}
