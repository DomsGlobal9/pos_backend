import { prisma } from '../../lib/prisma';
import { Actor, PERMISSIONS, may } from '../../types/actor';
import { badRequest, conflict, forbidden } from '../../utils/httpError';
import { call } from '../inventory-link/client';
import { planPayments, duplicateReferences, duplicateMessage, voucherCode } from '../payments';
import { PaymentInput } from '../sale/sale.schema';
import { shiftFor } from '../shifts';
import { record } from '../audit';

/**
 * GIFT VOUCHERS AT THE TILL (16 Oct; Inventory's PLAN-gift-vouchers.md, agreed with POS).
 *
 * Inventory holds every voucher and its balance; the till never keeps one. Selling is: take the money
 * here (counted, references typed), then ask Inventory for the code with the sale's own key -- a retry
 * gets the same voucher, never two -- and only then keep the till's record (voucher_sales), which is
 * there for the DRAWER: cash taken for a voucher is in it, and the shift and day close must say so.
 * Not a sale: no invoice number, no GST (charged on the goods when the voucher is used).
 *
 * Offline there is no voucher to sell: the code comes from Inventory, like a UPI QR.
 */
const SOLD_WITH = ['CASH', 'UPI', 'CARD'];
const UNREACHABLE = 'Inventory did not answer, so no voucher was made. Press Sell again: the same voucher comes back, never two. Do not give the money back yet.';

async function link(clientId: string) {
  const l = await prisma.inventoryLink.findUnique({ where: { clientId } });
  if (!l?.connected) throw conflict('Gift vouchers are kept in Inventory, and this shop is not connected to it.', { code: 'VOUCHER_UNAVAILABLE' });
  return l;
}

export interface SellVoucherInput {
  onceKey: string;
  amountPaise: number;
  counterId?: string;
  payments: PaymentInput[];
  buyer?: { name?: string; phone?: string };
}

export async function sellVoucher(actor: Actor, input: SellVoucherInput) {
  if (actor.kind !== 'USER' || !may(actor, PERMISSIONS.SELL)) throw forbidden('Only someone at the till can sell a gift voucher.', { code: 'NOT_PERMITTED' });
  const done = await prisma.voucherSale.findUnique({ where: { clientId_onceKey: { clientId: actor.clientId, onceKey: input.onceKey } } });
  if (done) return view(done);

  if (input.payments.some(p => !SOLD_WITH.includes(p.method))) throw badRequest('A gift voucher is paid for in cash, UPI or card.', { code: 'BAD_PAYMENT' });
  if (input.payments.some(p => (p as any).unconfirmed)) throw badRequest('A gift voucher is as good as cash: take the payment for certain, not "to check later".', { code: 'MUST_BE_CONFIRMED' });
  const settings = await prisma.shopSettings.findUnique({ where: { clientId: actor.clientId }, select: { enabledPaymentMethods: true, giftVouchers: true } });
  // What Inventory's catalogue said (19 Oct): off, or outside the shop's limits, is refused before anything is sent.
  const rules = settings?.giftVouchers as { enabled?: boolean; minPaise?: number | null; maxPaise?: number | null } | null;
  if (rules && rules.enabled === false) throw conflict('Gift vouchers are switched off for this shop. Switch them on in Inventory → Settings → Gift vouchers.', { code: 'VOUCHERS_OFF' });
  if (rules?.minPaise && input.amountPaise < rules.minPaise) throw badRequest(`A voucher here is at least ₹${(rules.minPaise / 100).toLocaleString('en-IN')}.`, { code: 'AMOUNT' });
  if (rules?.maxPaise && input.amountPaise > rules.maxPaise) throw badRequest(`A voucher here is at most ₹${(rules.maxPaise / 100).toLocaleString('en-IN')}.`, { code: 'AMOUNT' });
  // The till's own rules first: amounts add up, references look right, the ₹2 lakh cash rule (269ST).
  const planned = planPayments(input.amountPaise, input.payments, settings?.enabledPaymentMethods ?? [], 'EXACT');
  const dupes = await duplicateReferences(prisma as any, actor.clientId, planned);
  if (dupes.length) throw conflict(duplicateMessage(dupes[0]).replace(' — ask the customer for the right one, or a manager can allow it.', '.'), { code: 'REFERENCE_USED' });

  const l = await link(actor.clientId);
  const buyer = input.buyer && (input.buyer.name?.trim() || input.buyer.phone?.trim())
    ? { ...(input.buyer.name?.trim() ? { name: input.buyer.name.trim().slice(0, 80) } : {}), ...(input.buyer.phone?.trim() ? { phone: input.buyer.phone.trim() } : {}) }
    : undefined;
  const reply = await call(l, 'POST', '/vouchers', {
    idempotencyKey: input.onceKey,
    amountPaise: input.amountPaise,
    payments: planned.map(p => ({ method: p.method, amountPaise: p.amountPaise, ...(p.reference ? { reference: p.reference } : {}) })),
    ...(buyer ? { buyer } : {})
  }, 15_000);
  if (reply.kind === 'UNREACHABLE' || reply.status >= 500) throw conflict(UNREACHABLE, { code: 'VOUCHER_UNREACHABLE' });
  const data = reply.body?.data ?? {};
  if (reply.status !== 200) throw conflict(String(data.detail ?? 'Inventory did not make the voucher.'), { code: data.answer ?? 'VOUCHER_REFUSED' });
  if (!voucherCode(data.code)) throw conflict(UNREACHABLE, { code: 'VOUCHER_UNREACHABLE' });

  const cashPaise = planned.filter(p => p.method === 'CASH').reduce((n, p) => n + p.amountPaise, 0);
  const saved = await prisma.$transaction(async (tx) => {
    const shiftId = await shiftFor(tx, actor, input.counterId ?? null);
    return tx.voucherSale.upsert({
      where: { clientId_onceKey: { clientId: actor.clientId, onceKey: input.onceKey } },
      update: {},
      create: {
        clientId: actor.clientId, code: data.code, amountPaise: input.amountPaise, cashPaise,
        payments: planned.map(p => ({ method: p.method, amountPaise: p.amountPaise, reference: p.reference, tenderedPaise: p.tenderedPaise, changePaise: p.changePaise })) as any,
        expiresAt: new Date(data.expiresAt), buyerName: buyer?.name ?? null, buyerPhone: buyer?.phone ?? null,
        counterId: input.counterId ?? null, shiftId, soldById: actor.id, onceKey: input.onceKey
      }
    });
  });
  await record(actor, { action: 'voucher.sold', subject: saved.code, detail: { amountPaise: saved.amountPaise, cashPaise, methods: planned.map(p => p.method) } });
  return view(saved);
}

function view(v: { code: string; amountPaise: number; expiresAt: Date; payments: any; buyerName: string | null; createdAt: Date }) {
  const payments = (v.payments as any[]) ?? [];
  return {
    code: v.code, amountPaise: v.amountPaise, expiresAt: v.expiresAt, buyerName: v.buyerName, soldAt: v.createdAt, payments,
    changePaise: payments.reduce((n, p) => n + (p.changePaise ?? 0), 0)
  };
}

/** What a code is good for on this bill, in Inventory's words. A wrong code is an answer, not an error. */
export async function checkVoucher(actor: Actor, rawCode: string, billPaise?: number) {
  const code = voucherCode(rawCode);
  if (!code) return { code: String(rawCode ?? '').slice(0, 20), status: 'UNKNOWN', balancePaise: 0, usablePaise: 0, expiresAt: null, buyerName: null, buyerPhone: null, reason: 'That is not a gift voucher code. It looks like GV-7KQ2-9XMA.' };
  const l = await link(actor.clientId);
  const q = billPaise !== undefined ? `?billPaise=${Math.max(0, Math.round(billPaise))}` : '';
  const reply = await call(l, 'GET', `/vouchers/${encodeURIComponent(code)}${q}`, undefined, 8_000);
  if (reply.kind === 'UNREACHABLE' || reply.status >= 500) throw conflict('Inventory did not answer. Check the voucher again in a moment.', { code: 'VOUCHER_UNREACHABLE' });
  const data = reply.body?.data ?? {};
  if (reply.status !== 200) throw conflict(String(data.detail ?? 'Inventory could not check that voucher.'), { code: data.answer ?? 'VOUCHER_REFUSED' });
  return data;
}

/** Voucher sales in a period, for the day close. */
export async function vouchersSold(clientId: string, start: Date, end: Date) {
  const rows = await prisma.voucherSale.findMany({ where: { clientId, createdAt: { gte: start, lt: end } }, select: { amountPaise: true, payments: true } });
  const byMethod: Record<string, number> = {};
  for (const r of rows) for (const p of (r.payments as any[]) ?? []) byMethod[p.method] = (byMethod[p.method] ?? 0) + (p.amountPaise ?? 0);
  return { count: rows.length, totalPaise: rows.reduce((n, r) => n + r.amountPaise, 0), byMethod };
}
