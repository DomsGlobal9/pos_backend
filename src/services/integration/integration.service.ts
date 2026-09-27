import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { badRequest, notFound } from '../../utils/httpError';
import { mustHaveScope } from '../api-keys';
import { findByPhone } from '../customers';
import { day, dayRange } from '../day-close';

/**
 * What a shop's own software can READ. POS-API-002, -003, -006, -007.
 *
 * PUBLIC IDENTITIES ONLY (MASTER §3): a bill is its invoice number, an item its code, a customer
 * their phone number. None of our ids leave -- a client's database must not be coupled to our
 * primary keys, and an id that means nothing outside this system is one more thing to leak.
 *
 * Amounts in paise, integers, like everything else in the POS. Times in UTC (ISO 8601); a trading
 * day is the shop's own calendar date.
 */

const PAGE_MAX = 200;

const encodeCursor = (t: Date, n: string) => Buffer.from(JSON.stringify([t.toISOString(), n])).toString('base64url');
function decodeCursor(c: string): { t: Date; n: string } {
  try {
    const [t, n] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    const d = new Date(t);
    if (Number.isNaN(d.getTime()) || typeof n !== 'string') throw new Error();
    return { t: d, n };
  } catch { throw badRequest('That cursor is not one this API gave out. Start again without "after".'); }
}

/** POS-API-002. Bills in a date range, oldest first, paged with an opaque cursor. */
export async function sales(actor: Actor, q: { from?: string; to?: string; after?: string; limit?: string }) {
  mustHaveScope(actor, 'sales:read');
  if (!q.from || !q.to) throw badRequest('Say which days, with ?from=2026-09-01&to=2026-09-30 (the shop\'s own dates).');
  const start = dayRange(q.from).start;
  const end = dayRange(q.to).end;
  if (end <= start) throw badRequest('"to" is before "from".');
  if (end.getTime() - start.getTime() > 93 * 86_400_000) throw badRequest('At most three months at a time. Ask for the next months separately.');
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), PAGE_MAX);
  const after = q.after ? decodeCursor(q.after) : null;

  const rows = await prisma.sale.findMany({
    where: {
      clientId: actor.clientId,
      createdAt: { gte: start, lt: end },
      ...(after ? { OR: [{ createdAt: { gt: after.t } }, { createdAt: after.t, invoiceNo: { gt: after.n } }] } : {})
    },
    orderBy: [{ createdAt: 'asc' }, { invoiceNo: 'asc' }],
    take: limit + 1,
    select: {
      invoiceNo: true, createdAt: true, kind: true, status: true, subtotalPaise: true, discountPaise: true, taxPaise: true,
      roundOffPaise: true, totalPaise: true, madeOfflineAt: true,
      customer: { select: { phone: true, name: true } },
      payments: { select: { method: true, amountPaise: true } }
    }
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    sales: page.map(s => ({
      invoiceNo: s.invoiceNo,
      at: s.createdAt,
      kind: s.kind,
      status: s.status,
      subtotalPaise: s.subtotalPaise, discountPaise: s.discountPaise, taxPaise: s.taxPaise, roundOffPaise: s.roundOffPaise, totalPaise: s.totalPaise,
      customer: s.customer ? { phone: s.customer.phone, name: s.customer.name } : null,
      paidBy: s.payments.map(p => ({ method: p.method, amountPaise: p.amountPaise })),
      madeOffline: !!s.madeOfflineAt
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.invoiceNo) : null
  };
}

/** POS-API-003. One bill as it was charged -- frozen lines, GST split, payments, and what came back. */
export async function sale(actor: Actor, invoiceNo: string) {
  mustHaveScope(actor, 'sales:read');
  const s = await prisma.sale.findFirst({
    where: { clientId: actor.clientId, invoiceNo },
    select: {
      id: true, invoiceNo: true, financialYear: true, createdAt: true, kind: true, status: true,
      subtotalPaise: true, discountPaise: true, taxPaise: true, roundOffPaise: true, totalPaise: true, madeOfflineAt: true,
      counter: { select: { name: true } }, cashier: { select: { name: true } },
      customer: { select: { phone: true, name: true, gstin: true } },
      lines: {
        select: {
          description: true, hsn: true, qty: true, unitPricePaise: true, discountPaise: true, taxRate: true, taxPaise: true,
          cgstPaise: true, sgstPaise: true, igstPaise: true, lineTotalPaise: true, item: { select: { code: true } }
        }
      },
      payments: { orderBy: { createdAt: 'asc' }, select: { method: true, amountPaise: true, reference: true, status: true, createdAt: true } }
    }
  });
  if (!s) throw notFound(`No bill ${invoiceNo} in this shop. Send the full number, e.g. INV/2026-27/0012, URL-encoded.`, { code: 'UNKNOWN_INVOICE' });
  const returns = await prisma.return.findMany({
    where: { clientId: actor.clientId, originalSaleId: s.id },
    orderBy: { createdAt: 'asc' },
    select: { creditNoteNo: true, createdAt: true, totalPaise: true, taxPaise: true, refundMethod: true, reason: true }
  });
  return {
    invoiceNo: s.invoiceNo, financialYear: s.financialYear, at: s.createdAt, kind: s.kind, status: s.status,
    counter: s.counter?.name ?? null, cashier: s.cashier?.name ?? null,
    customer: s.customer ? { phone: s.customer.phone, name: s.customer.name, gstin: s.customer.gstin } : null,
    lines: s.lines.map(l => ({
      itemCode: l.item?.code ?? null, description: l.description, hsn: l.hsn, qty: l.qty,
      unitPricePaise: l.unitPricePaise, discountPaise: l.discountPaise, taxRate: l.taxRate, taxPaise: l.taxPaise,
      cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, igstPaise: l.igstPaise, lineTotalPaise: l.lineTotalPaise
    })),
    subtotalPaise: s.subtotalPaise, discountPaise: s.discountPaise, taxPaise: s.taxPaise, roundOffPaise: s.roundOffPaise, totalPaise: s.totalPaise,
    payments: s.payments.map(p => ({ method: p.method, amountPaise: p.amountPaise, reference: p.reference, status: p.status, at: p.createdAt })),
    returns: returns.map(r => ({ creditNoteNo: r.creditNoteNo, at: r.createdAt, totalPaise: r.totalPaise, taxPaise: r.taxPaise, refundMethod: r.refundMethod, reason: r.reason })),
    madeOffline: !!s.madeOfflineAt
  };
}

/** POS-API-006. A customer by phone, or null -- not having met someone is an answer, not an error. */
export async function customer(actor: Actor, phone: string | undefined) {
  mustHaveScope(actor, 'customers:read');
  if (!phone) throw badRequest('Say which number, with ?phone=9876543210');
  const c = await findByPhone(actor, phone);
  if (!c) return null;
  return {
    phone: c.phone, name: c.name, gstin: c.gstin, storeCreditPaise: c.storeCreditPaise,
    visits: c.visitCount, spentPaise: c.lifetimeSpentPaise, firstSeenAt: c.firstSeenAt, lastSeenAt: c.lastSeenAt
  };
}

/** POS-API-007. A trading day's figures: frozen as closed, or live with `closed: false`. */
export async function dayFigures(actor: Actor, date: string) {
  mustHaveScope(actor, 'day:read');
  const d = await day(actor, date);
  return {
    date: d.date,
    closed: !!d.closed,
    closedAt: d.closed?.closedAt ?? null,
    figures: d.closed?.figures ?? d.live,
    sinceClosing: d.closed?.since ?? null
  };
}
