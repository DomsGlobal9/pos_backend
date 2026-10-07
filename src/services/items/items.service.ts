import { prisma } from '../../lib/prisma';
import { literal } from '../../utils/likeText';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { forbidden } from '../../utils/httpError';

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
  hsn: true, pricePaise: true, taxRate: true, cachedQty: true, cachedQtyAt: true, active: true,
  imageUrl: true, variantGroup: true
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
  imageUrl: string | null;
  /** Set when this item is one of several colours or sizes of the same thing. POS-SELL-006. */
  variantGroup: string | null;
  /** How many items share that group, including this one. 1 means it stands alone, so the screen
   * adds it straight to the basket instead of opening a picker. */
  variantCount: number;
  /**
   * Set when this row STANDS FOR a group rather than for itself -- several colours of one saree
   * matched, so they are shown as one row and the cashier picks. The figure is the cheapest in the
   * group, so the screen can say "from ₹12,999" honestly.
   *
   * Null on an ordinary row, including a group's row when only one of its variants matched the
   * search: someone who typed "maroon" has already chosen, and making them choose again is a tap
   * for nothing.
   */
  priceFromPaise: number | null;
}

export interface SearchResult {
  exact: boolean;
  items: FoundItem[];
  /**
   * An exact match whose code is ALSO the start of other codes ("COT-01" when "COT-010" exists). The
   * till adds an exact match by itself when the cashier stops typing -- but not this one, because the
   * cashier may simply have paused halfway through the longer code. Enter still adds it.
   */
  prefixOfOthers?: boolean;
}

function shape(row: any, variantCount = 1): FoundItem {
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
    qtyAsOf: row.cachedQtyAt,
    imageUrl: row.imageUrl ?? null,
    variantGroup: row.variantGroup ?? null,
    variantCount,
    priceFromPaise: null
  };
}

/**
 * Several colours of one saree become one row.
 *
 * Without this, searching "kanchipuram" in a shop that stocks it in three colours returns three
 * near-identical rows that each say "3 colours" -- which is worse than no grouping at all, and is
 * exactly what the first version of this feature did. Caught by looking at the screen.
 *
 * The rule: a group collapses only when MORE THAN ONE of its variants matched. One match means the
 * cashier's words already narrowed it -- "kanchipuram maroon" -- and collapsing there would make
 * them choose something they have already chosen.
 *
 * The cheapest variant represents the group, because "from ₹12,999" is the honest way to show a
 * range and the one a customer hears as a price.
 */
function collapseGroups(items: FoundItem[]): FoundItem[] {
  const byGroup = new Map<string, FoundItem[]>();
  for (const item of items) {
    if (!item.variantGroup) continue;
    const list = byGroup.get(item.variantGroup) ?? [];
    list.push(item);
    byGroup.set(item.variantGroup, list);
  }

  const collapsed = new Set<string>();
  const out: FoundItem[] = [];

  for (const item of items) {
    const group = item.variantGroup;
    const siblings = group ? byGroup.get(group) ?? [] : [];

    if (!group || siblings.length < 2) {
      out.push(item);
      continue;
    }
    if (collapsed.has(group)) continue;
    collapsed.add(group);

    const cheapest = siblings.reduce((low, s) => (s.pricePaise < low.pricePaise ? s : low), siblings[0]);
    out.push({
      ...cheapest,
      // The screen must not claim a stock figure for a row that stands for three different pieces.
      availableQty: null,
      qtyAsOf: null,
      priceFromPaise: cheapest.pricePaise
    });
  }

  return out;
}

/**
 * How many sellable items share each of these groups.
 *
 * One query for the whole result set rather than one per row: a search returning 25 items would
 * otherwise cost 25 extra round trips, on the screen with the tightest latency budget in the
 * product.
 */
async function countVariants(clientId: string, rows: any[]): Promise<Map<string, number>> {
  const groups = [...new Set(rows.map(r => r.variantGroup).filter(Boolean))] as string[];
  if (groups.length === 0) return new Map();
  const counts = await prisma.item.groupBy({
    by: ['variantGroup'],
    where: { clientId, active: true, variantGroup: { in: groups } },
    _count: { _all: true }
  });
  return new Map(counts.map(c => [c.variantGroup as string, c._count._all]));
}

const withCounts = async (clientId: string, rows: any[]): Promise<FoundItem[]> => {
  const counts = await countVariants(clientId, rows);
  return rows.map(r => shape(r, r.variantGroup ? counts.get(r.variantGroup) ?? 1 : 1));
};

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

  /*
   * A scanned barcode is one specific piece -- a maroon saree, not "a saree in some colour". So an
   * exact match goes straight into the basket even when siblings exist. The picker is for someone
   * typing a name, which is the case where the colour has not been chosen yet.
   */
  if (exact.length === 1) {
    const longer = await prisma.item.count({
      where: {
        ...sellable, id: { not: exact[0].id },
        OR: [
          { code: { startsWith: literal(q), mode: 'insensitive' } },
          { barcode: { startsWith: literal(q) } }
        ]
      }
    });
    return { exact: true, items: [shape(exact[0])], ...(longer > 0 ? { prefixOfOthers: true } : {}) };
  }
  if (exact.length > 1) return { exact: false, items: await withCounts(actor.clientId, exact) };

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

  const items = collapseGroups(await withCounts(actor.clientId, matches));
  items.sort((a, b) => Number((b.availableQty ?? 1) > 0) - Number((a.availableQty ?? 1) > 0));
  return { exact: false, items };
}

/**
 * Every colour and size of one thing. POS-SELL-006, the data behind WF-PRODUCT-01.
 *
 * A saree shop's search for "kanchipuram" returns the same saree five times in five colours, and a
 * cashier then reads five near-identical rows to find the one in the customer's hand. This turns
 * that into one row and a picker.
 *
 * Out-of-stock variants are RETURNED, not filtered out. "We have it in green but not in blue" is
 * something the assistant needs to be able to say, and a picker that silently omits blue makes
 * them say "we do not have it" instead.
 */
export async function variantsOf(actor: Actor, group: string): Promise<FoundItem[]> {
  const rows = await prisma.item.findMany({
    where: { clientId: actor.clientId, active: true, variantGroup: group },
    select: SELECT
  });
  // Sorted here rather than in the query: SQL cannot put S before M before L, and a size picker in
  // the wrong order is the first thing a shop assistant will complain about.
  return rows
    .sort(bySizeThenColour)
    .map(r => shape(r, rows.length));
}

/**
 * The order a size picker has to be in.
 *
 * Sorting sizes as text is wrong in both directions a clothing shop actually uses them:
 *
 *     letters    L, M, S, XL        instead of   S, M, L, XL
 *     numbers    10, 38, 40, 8      instead of   8, 10, 38, 40
 *
 * Both are the kind of thing nobody writes a ticket about; they just find the till annoying and
 * go slower. So letters get a known running order, numbers sort numerically, and anything else
 * (a saree is "Free") falls to the end alphabetically. Colour breaks the tie.
 */
const LETTER_SIZES = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', '2xl', '3xl'];

export function sizeRank(size: string | null): [number, number, string] {
  const text = (size ?? '').trim().toLowerCase();
  if (!text) return [3, 0, ''];

  const letter = LETTER_SIZES.indexOf(text);
  if (letter >= 0) return [0, letter, text];

  const number = Number(text);
  if (Number.isFinite(number)) return [1, number, text];

  return [2, 0, text];
}

function bySizeThenColour(a: any, b: any) {
  const [aGroup, aValue, aText] = sizeRank(a.size);
  const [bGroup, bValue, bText] = sizeRank(b.size);
  if (aGroup !== bGroup) return aGroup - bGroup;
  if (aValue !== bValue) return aValue - bValue;
  if (aText !== bText) return aText < bText ? -1 : 1;
  return (a.colour ?? '') < (b.colour ?? '') ? -1 : (a.colour ?? '') > (b.colour ?? '') ? 1 : 0;
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

/**
 * The item list as the OWNER sees it, for the Items screen. POS-STAND-003.
 *
 * Not the sell search: that one shows only what can be sold, groups a saree's colours into one
 * row, and never carries a cost. This is the opposite -- every item including the ones switched
 * off, one row each, so the person who has to correct a price can find the thing they typed
 * wrong. Owner only, for the same reason the import is.
 */
export async function listForManaging(actor: Actor, rawQuery: unknown) {
  if (!may(actor, PERMISSIONS.SETTINGS)) {
    throw forbidden('Only the owner can see and change the item list.', { code: 'NOT_PERMITTED' });
  }
  const q = String((rawQuery as any)?.q ?? '').trim();
  const where = {
    clientId: actor.clientId,
    ...(q
      ? {
        OR: [
          { code: { contains: q, mode: 'insensitive' as const } },
          { name: { contains: q, mode: 'insensitive' as const } },
          { barcode: { contains: q } }
        ]
      }
      : {})
  };
  const [rows, total] = await Promise.all([
    prisma.item.findMany({
      where, orderBy: [{ active: 'desc' }, { name: 'asc' }], take: 200,
      select: {
        code: true, name: true, pricePaise: true, taxRate: true, hsn: true, barcode: true,
        cachedQty: true, colour: true, size: true, variantGroup: true, active: true
      }
    }),
    prisma.item.count({ where: { clientId: actor.clientId } })
  ]);
  const link = await prisma.inventoryLink.findUnique({
    where: { clientId: actor.clientId }, select: { connected: true }
  });
  return {
    // The screen hides its own Add form when Inventory owns the list, rather than offering a form
    // that can only be refused.
    fromInventory: link?.connected === true,
    total,
    shown: rows.length,
    items: rows.map(r => ({
      code: r.code, name: r.name, pricePaise: r.pricePaise, taxRate: r.taxRate, hsn: r.hsn,
      barcode: r.barcode, qty: r.cachedQty, colour: r.colour, size: r.size, group: r.variantGroup,
      active: r.active
    }))
  };
}
