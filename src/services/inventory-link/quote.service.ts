import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { call } from './client';

/**
 * Offers at the till. Contract §9: ONE pricing engine, and it is Inventory's.
 *
 * The POS never computes an offer -- no rules copied down, no cache of them, no second
 * implementation. It asks Inventory for a quote as the basket changes and, when the sale lands,
 * uses each quoted line total VERBATIM. The POS stays the authority for the bill and for anything a
 * person typed (a manual discount, a price override), because that is a person at a counter, not
 * an offer.
 *
 * THE BROWSER NEVER CARRIES A PRICE. A till that accepted "this line is Rs 2,700 because Inventory
 * said so" from its own client is a till where dev tools sell a silk saree for a rupee. So the
 * quote is fetched HERE and HELD HERE, and at Complete the sale re-reads it by quoteId. The browser
 * only ever sends the id.
 *
 * A QUOTE IS ADVISORY AND NEVER BLOCKS A SALE. No answer, any non-200, Inventory down, the quote
 * expired or lost: the till sells at its own prices and says so in one line. An offer-less bill is
 * never refused, on either side (§9.5).
 *
 * ponytail: the held quotes live in this process, which is one instance. A restart loses them,
 * and a sale that then names a lost quote degrades to "Offers could not be checked" -- the exact
 * failure the contract already allows. A second instance or a 15-minute outage would want a
 * table; neither exists today.
 */

export interface QuoteLineOffer { offerId: string; name?: string; discountPaise: number }
export interface QuoteLine {
  itemCode: string;
  qty: number;
  unpriced?: boolean;
  listUnitPaise?: number;
  discountPaise?: number;
  lineTotalPaise?: number;
  offers?: QuoteLineOffer[];
}
export interface Quote {
  quoteId: string;
  validUntil: string;
  lines: QuoteLine[];
  totalPaise: number;
  coupon?: { code: string; accepted: boolean; reason?: string };
  notes?: string[];
}
export type QuoteResult = { ok: true; quote: Quote } | { ok: false; reason: string };

export interface QuoteInput {
  lines: { itemId: string; qty: number }[];
  customerId?: string;
  couponCode?: string;
}

const QUOTE_TIMEOUT_MS = 8_000;
export const COULD_NOT_CHECK = 'Offers could not be checked. Sold at the shop\'s own prices.';

const held = new Map<string, { clientId: string; quote: Quote; expiresAt: number }>();

function sweep() {
  const now = Date.now();
  for (const [id, h] of held) if (h.expiresAt <= now) held.delete(id);
}

/** Ask Inventory what this basket comes to with the shop's offers on it. Never throws for a bad answer. */
export async function quoteBasket(actor: Actor, input: QuoteInput): Promise<QuoteResult> {
  const link = await prisma.inventoryLink.findUnique({ where: { clientId: actor.clientId } });
  if (!link?.connected) return { ok: false, reason: 'This shop is not connected to Inventory.' };

  // Ids to codes, and the same code once: Inventory refuses a duplicate itemCode (§9.2).
  const rows = await prisma.item.findMany({
    where: { clientId: actor.clientId, id: { in: input.lines.map(l => l.itemId) } },
    select: { id: true, code: true }
  });
  const codeOf = new Map(rows.map(r => [r.id, r.code]));
  const qtyByCode = new Map<string, number>();
  for (const l of input.lines) {
    const code = codeOf.get(l.itemId);
    if (!code) continue;
    qtyByCode.set(code, (qtyByCode.get(code) ?? 0) + l.qty);
  }
  if (qtyByCode.size === 0) return { ok: false, reason: 'Nothing on this bill is known to Inventory.' };

  const customer = input.customerId
    ? await prisma.customer.findFirst({ where: { id: input.customerId, clientId: actor.clientId }, select: { phone: true } })
    : null;

  const reply = await call(link, 'POST', '/quote', {
    lines: [...qtyByCode].map(([itemCode, qty]) => ({ itemCode, qty })),
    ...(customer?.phone ? { customerRef: customer.phone } : {}),
    ...(input.couponCode ? { couponCode: input.couponCode } : {})
  }, QUOTE_TIMEOUT_MS);

  if (reply.kind === 'UNREACHABLE') return { ok: false, reason: `Offers could not be checked: Inventory did not answer (${reply.reason}).` };
  if (reply.status !== 200) {
    const detail = reply.body?.data?.detail ?? reply.body?.message;
    return { ok: false, reason: `Offers could not be checked${detail ? `: ${detail}` : ` (Inventory answered ${reply.status})`}.` };
  }
  const q = reply.body?.data;
  if (!q || typeof q.quoteId !== 'string' || !Array.isArray(q.lines)) {
    return { ok: false, reason: 'Offers could not be checked: the answer could not be read.' };
  }
  const expiresAt = Date.parse(q.validUntil);
  sweep();
  held.set(q.quoteId, { clientId: actor.clientId, quote: q, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 15 * 60_000 });
  return { ok: true, quote: q };
}

/** The quote a sale names, if this shop asked for it and it has not expired. Null is "could not be checked". */
export function heldQuote(clientId: string, quoteId: string): Quote | null {
  const h = held.get(quoteId);
  if (!h || h.clientId !== clientId || h.expiresAt <= Date.now()) return null;
  return h.quote;
}

/** Tests only: a quote that has gone the way a restart or a 15-minute wait would send it. */
export function __forgetQuote(quoteId: string) { held.delete(quoteId); }
