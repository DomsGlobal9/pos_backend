import { prisma } from '../../lib/prisma';
import { newReceiptToken as newToken, receiptUrl } from '../../utils/receiptLink';
import { Actor, systemActor } from '../../types/actor';
import { notFound } from '../../utils/httpError';
import { getSale } from '../sale/sale.service';
import { receiptDocument } from './document';
import { renderPdf } from './pdf';

/**
 * Digital receipts. POS-RCPT-002 (PDF), POS-RCPT-009 (the receipt's own web address).
 *
 * THE LINK IS THE KEY. A bill's digital receipt lives at /r/<token>, where the token is 24 random
 * characters made when the bill is saved. Anyone holding the paper -- which carries it as a QR code
 * -- can open it; nobody can guess one. It shows the bill and nothing else: no ids, no other bills,
 * the customer's number masked exactly as on the paper.
 */

export { newToken, receiptUrl };

/**
 * The token for a bill, making one if the bill predates digital receipts. Safe under a race: the
 * update only fills an empty slot, so two callers end up reading the same token.
 */
export async function ensureToken(actor: Actor, saleId: string): Promise<string> {
  const sale = await prisma.sale.findFirst({ where: { id: saleId, clientId: actor.clientId }, select: { receiptToken: true } });
  if (!sale) throw notFound('That bill was not found.');
  if (sale.receiptToken) return sale.receiptToken;
  await prisma.sale.updateMany({ where: { id: saleId, clientId: actor.clientId, receiptToken: null }, data: { receiptToken: newToken() } });
  const after = await prisma.sale.findFirstOrThrow({ where: { id: saleId }, select: { receiptToken: true } });
  return after.receiptToken!;
}

export async function receiptLink(actor: Actor, saleId: string) {
  const token = await ensureToken(actor, saleId);
  return { token, url: receiptUrl(token) };
}

/** The bill as a PDF, for the till's own Download button and for WhatsApp. */
export async function pdfFor(actor: Actor, saleId: string) {
  const token = await ensureToken(actor, saleId);
  const sale = await getSale(actor, saleId);
  const url = receiptUrl(token);
  const logo = await httpsLogo(sale.shop?.logoUrl);
  return { invoiceNo: sale.invoiceNo, pdf: renderPdf(receiptDocument(sale, { receiptUrl: url, logo }), { qr: url }), sale, url };
}

// ponytail: per-process cache keyed by address; a new logo in Inventory is a new address.
const logos = new Map<string, Buffer>();

/**
 * Inventory's logo (an https picture) for the PDF, fetched once and kept. Slow or broken: the PDF
 * goes without it -- a WhatsApp bill is never held up for a picture.
 */
async function httpsLogo(logoUrl: unknown): Promise<Buffer | null> {
  if (typeof logoUrl !== 'string' || !logoUrl.startsWith('https://')) return null;
  const kept = logos.get(logoUrl);
  if (kept) return kept;
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 2_000_000) return null;
    if (logos.size > 200) logos.clear();
    logos.set(logoUrl, bytes);
    return bytes;
  } catch {
    return null;
  }
}

/** Strip everything that identifies a row in OUR database. A public page gets the bill, not our keys. */
function publicShape(sale: any, token: string) {
  const { id, counter, cashier, customer, lines, payments, returns, exchangedFrom, ...rest } = sale;
  return {
    ...rest,
    receiptUrl: receiptUrl(token),
    counter: counter ? { name: counter.name } : null,
    cashier: cashier ? { name: cashier.name } : null,
    customer: customer ? { name: customer.name, phoneMasked: customer.phoneMasked } : null,
    // No internal id of any kind on a page anyone with the link can open: the line's, or the item's.
    lines: lines.map(({ id: _i, itemId: _t, ...l }: any) => l),
    payments: payments.map(({ id: _i, ...p }: any) => p),
    returns: (returns ?? []).map((r: any) => ({ creditNoteNo: r.creditNoteNo, totalPaise: r.totalPaise, createdAt: r.createdAt })),
    exchangedFrom: exchangedFrom ? { originalInvoiceNo: exchangedFrom.originalInvoiceNo, creditNoteNo: exchangedFrom.creditNoteNo } : null
  };
}

async function byToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token ?? '')) throw notFound('That receipt link is not right. Check it against the paper receipt.');
  const sale = await prisma.sale.findUnique({ where: { receiptToken: token }, select: { id: true, clientId: true } });
  if (!sale) throw notFound('That receipt link is not right. Check it against the paper receipt.');
  return sale;
}

/** GET /public/receipts/:token -- what the customer sees. */
export async function publicReceipt(token: string) {
  const ref = await byToken(token);
  const sale = await getSale(systemActor(ref.clientId), ref.id);
  return publicShape(sale, token);
}

export async function publicPdf(token: string) {
  const ref = await byToken(token);
  return pdfFor(systemActor(ref.clientId), ref.id);
}
