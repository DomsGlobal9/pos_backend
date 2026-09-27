import { prisma } from '../../lib/prisma';
import { literal } from '../../utils/likeText';
import { Actor } from '../../types/actor';

/**
 * Finding something to sell.
 *
 * The contract is carried over from Inventory's selling-search.service.ts, because it was worked
 * out against real cashiers and the reasons still hold:
 *
 *   1. An exact match on barcode, item code or SKU returns ONE item with exact: true, and the
 *      screen adds it straight to the basket. A scanner types the code and presses Enter; asking
 *      the cashier to then click the only result is a click per sale, all day.
 *   2. If two items match exactly -- one item's barcode is another's code, which does happen --
 *      both are returned with exact: false so the cashier picks. Falling through to word search
 *      here answered "nothing matches", which is worse than either.
 *   3. Otherwise, word search where EVERY word must match. "red silk m" narrows; it must not
 *      widen to everything red.
 *   4. Sellable and in stock sorts first. A list led by out-of-stock items is a list scrolled past.
 *
 * NEVER A COST PRICE. Not here, not in a field the screen happens to ignore. The Item table has no
 * cost column at all, which is the strongest version of that rule -- it cannot leak what it does
 * not hold.
 *
 * In standalone mode this reads the POS's own Item table. With Inventory behind it, the same shape
 * is answered from the cache and refreshed through the Gateway; the screen cannot tell the
 * difference, which is the point.
 */

const LIMIT = 25;

const SELECT = {
  id: true, code: true, barcode: true, name: true, colour: true, size: true,
  hsn: true, pricePaise: true, taxRate: true, cachedQty: true, cachedQtyAt: true, active: true
} as const;

export interface FoundItem {
  id: string;
  code: string;
  barcode: string | null;
  name: string;
  colour: string | null;
  size: string | null;
  hsn: string | null;
  pricePaise: number;
  taxRate: number;
  /** What is left here, so an assistant can say "last one" honestly. Null when unknown, which is
   * not the same as zero and must not be displayed as zero. */
  availableQty: number | null;
  /** Advisory only, and stale by design. A sale is NEVER blocked on it. */
  qtyAsOf: Date | null;
}

export interface SearchResult {
  exact: boolean;
  items: FoundItem[];
}

function shape(row: any): FoundItem {
  return {
    id: row.id,
    code: row.code,
    barcode: row.barcode,
    name: row.name,
    colour: row.colour,
    size: row.size,
    hsn: row.hsn,
    pricePaise: row.pricePaise,
    taxRate: row.taxRate,
    availableQty: row.cachedQty,
    qtyAsOf: row.cachedQtyAt
  };
}

export async function search(actor: Actor, rawQuery: unknown): Promise<SearchResult> {
  const q = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 80) : '';
  if (!q) return { exact: false, items: [] };

  const sellable = { clientId: actor.clientId, active: true };

  // A scanned or typed code. Escaped even for `equals`, because Prisma compares case-insensitively
  // with ILIKE and a bare percent there matched every code in the shop.
  const exact = await prisma.item.findMany({
    where: {
      ...sellable,
      OR: [
        { barcode: q },
        { code: { equals: literal(q), mode: 'insensitive' } }
      ]
    },
    select: SELECT,
    take: 2
  });

  if (exact.length === 1) return { exact: true, items: [shape(exact[0])] };
  if (exact.length > 1) return { exact: false, items: exact.map(shape) };

  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const matches = await prisma.item.findMany({
    where: {
      ...sellable,
      AND: words.map(word => ({
        OR: [
          { name: { contains: literal(word), mode: 'insensitive' as const } },
          { code: { contains: literal(word), mode: 'insensitive' as const } },
          { colour: { contains: literal(word), mode: 'insensitive' as const } },
          { size: { equals: literal(word), mode: 'insensitive' as const } }
        ]
      }))
    },
    select: SELECT,
    orderBy: [{ name: 'asc' }, { code: 'asc' }],
    take: LIMIT
  });

  const items = matches.map(shape);
  items.sort((a, b) => Number((b.availableQty ?? 1) > 0) - Number((a.availableQty ?? 1) > 0));
  return { exact: false, items };
}

/**
 * The rows a sale will actually be priced from.
 *
 * Separate from search on purpose. The browser sends item ids and quantities and NOTHING ELSE that
 * matters -- no prices. A till that accepts a price from its own client is a till where anyone who
 * can open dev tools sells a silk saree for a rupee. So the sale re-reads every price here, from
 * the database, inside its own transaction.
 */
export async function forSale(tx: any, clientId: string, itemIds: string[]) {
  if (itemIds.length === 0) return new Map<string, any>();
  const rows = await tx.item.findMany({
    where: { id: { in: itemIds }, clientId },
    select: SELECT
  });
  return new Map<string, any>(rows.map((r: any) => [r.id, r]));
}
