import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { call } from './client';
import { refreshMoneyStatus } from '../payments';
import { paymentUpdated } from '../events';

/**
 * UPI THAT CONFIRMS ITSELF (PLAN-payments Step 2). Opt-in per shop, switched on by the owner in
 * Inventory (the fee, 0.99%, lands on the shop's own Razorpay account). Inventory makes a single-use
 * QR for exactly the amount on the shop's Razorpay and is told when it is paid; the till never sees a
 * key. Contract with Inventory, 7 Oct: POST /upi-qr, GET /upi-qr/:qrId, POST /upi-qr/:qrId/close.
 *
 * The till NEVER trusts the screen's "paid". At Complete the server asks Inventory itself; only PAID
 * for exactly the amount is collected, with Razorpay's UTR. Anything else -- not paid yet, a different
 * amount, Inventory not answering -- is saved as a payment to check, never refused, and the sweep below
 * settles it the moment Razorpay says so. Money a customer paid is never lost.
 */

export type QrStatus =
  | { status: 'WAITING' | 'CLOSED' }
  | { status: 'PAID'; paymentId: string | null; utr: string | null; paidPaise: number; paidAt: string | null }
  | { status: 'PAID_WRONG_AMOUNT'; paidPaise: number }
  | { status: 'UNKNOWN'; reason: string };

const QR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLOW = 'Razorpay could not be reached just now. Use the shop\'s own UPI QR and type the reference.';

async function liveLink(clientId: string) {
  const link = await prisma.inventoryLink.findUnique({ where: { clientId } });
  return link?.connected ? link : null;
}

const REASONS: Record<string, string> = {
  NOT_CONNECTED: 'This shop has no Razorpay account connected in Inventory. Use the shop\'s own UPI QR.',
  NOT_ENABLED: 'Self-confirming UPI is switched off for this shop (Inventory -> Settings -> Razorpay account).',
  QR_NOT_ACTIVATED: 'Razorpay has not switched on QR Codes for this shop\'s account yet. Use the shop\'s own UPI QR.',
  TEST_KEYS: 'This shop\'s Razorpay is in test mode, which cannot take real money. Use the shop\'s own UPI QR.'
};

/** A QR for exactly this amount, or a sentence saying why not (the till then shows the shop's own QR). */
export async function createQr(actor: Actor, input: { amountPaise: number; idempotencyKey: string; invoiceRef?: string }):
  Promise<{ ok: true; qrId: string; imageUrl: string; amountPaise: number; expiresAt: string | null } | { ok: false; reason: string }> {
  const link = await liveLink(actor.clientId);
  if (!link) return { ok: false, reason: REASONS.NOT_CONNECTED };
  const settings = await prisma.shopSettings.findUnique({ where: { clientId: actor.clientId }, select: { upiQrEnabled: true } });
  if (!settings?.upiQrEnabled) return { ok: false, reason: REASONS.NOT_ENABLED };
  const reply = await call(link, 'POST', '/upi-qr', input, 8_000);
  if (reply.kind === 'UNREACHABLE') return { ok: false, reason: SLOW };
  const d = reply.body?.data ?? {};
  if (reply.status !== 200 && reply.status !== 201) {
    return { ok: false, reason: REASONS[d.answer] ?? d.detail ?? SLOW };
  }
  // Only a picture Razorpay hosts over https is shown; anything else is not a QR the till will draw.
  if (!QR_ID.test(String(d.qrId ?? '')) || typeof d.imageUrl !== 'string' || !/^https:\/\//.test(d.imageUrl)) return { ok: false, reason: SLOW };
  if (d.amountPaise !== input.amountPaise) return { ok: false, reason: SLOW };
  return { ok: true, qrId: d.qrId, imageUrl: d.imageUrl, amountPaise: d.amountPaise, expiresAt: d.expiresAt ?? null };
}

export async function qrStatus(clientId: string, qrId: string): Promise<QrStatus> {
  if (!QR_ID.test(qrId)) return { status: 'UNKNOWN', reason: 'Not a QR this till made.' };
  const link = await liveLink(clientId);
  if (!link) return { status: 'UNKNOWN', reason: REASONS.NOT_CONNECTED };
  const reply = await call(link, 'GET', `/upi-qr/${encodeURIComponent(qrId)}`, undefined, 6_000);
  if (reply.kind === 'UNREACHABLE' || reply.status !== 200) return { status: 'UNKNOWN', reason: SLOW };
  return shapeOf(reply.body?.data ?? {});
}

/** Close an unpaid QR when the cashier takes another way. Already paid: PAID, so it is taken, not lost. */
export async function closeQr(clientId: string, qrId: string): Promise<QrStatus> {
  if (!QR_ID.test(qrId)) return { status: 'UNKNOWN', reason: 'Not a QR this till made.' };
  const link = await liveLink(clientId);
  if (!link) return { status: 'UNKNOWN', reason: REASONS.NOT_CONNECTED };
  const reply = await call(link, 'POST', `/upi-qr/${encodeURIComponent(qrId)}/close`, {}, 6_000);
  if (reply.kind === 'UNREACHABLE' || reply.status >= 500) return { status: 'UNKNOWN', reason: SLOW };
  return shapeOf(reply.body?.data ?? {});
}

function shapeOf(d: any): QrStatus {
  if (d.status === 'PAID') {
    return { status: 'PAID', paymentId: typeof d.paymentId === 'string' ? d.paymentId : null, utr: typeof d.utr === 'string' ? d.utr : null, paidPaise: Number(d.paidPaise), paidAt: d.paidAt ?? null };
  }
  if (d.status === 'PAID_WRONG_AMOUNT') return { status: 'PAID_WRONG_AMOUNT', paidPaise: Number(d.paidPaise) };
  if (d.status === 'WAITING' || d.status === 'CLOSED') return { status: d.status };
  return { status: 'UNKNOWN', reason: SLOW };
}

/**
 * At Complete: each UPI payment carrying a qrId is checked with Inventory HERE, not taken from the
 * screen. Paid for exactly its amount: collected, its reference Razorpay's UTR. Otherwise it is kept
 * as a payment to check, with its qrId, for the sweep. Called before the sale's transaction, like holds.
 */
export async function verifyQrPayments<T extends { method: string; amountPaise: number; qrId?: string; reference?: string; unconfirmed?: boolean }>(
  clientId: string, payments: T[]
): Promise<T[]> {
  const out: T[] = [];
  for (const p of payments) {
    // "Verified" is only ever set here, by asking Inventory -- never carried in from outside.
    const { gatewayVerified: _ignored, ...plain } = p as any;
    if (p.method !== 'UPI' || !p.qrId) { out.push(plain as T); continue; }
    const s = await qrStatus(clientId, p.qrId);
    if (s.status === 'PAID' && s.paidPaise === p.amountPaise && (s.utr || s.paymentId)) {
      out.push({ ...p, reference: s.utr ?? s.paymentId!, unconfirmed: false, gatewayVerified: true } as T);
    } else {
      out.push({ ...p, reference: undefined, unconfirmed: true } as T);
    }
  }
  return out;
}

/**
 * THE SWEEP: a QR payment saved as "to check" (not yet paid at Complete, or Inventory slow) is asked
 * about again on every delivery pass, and settled the moment Razorpay says it was paid in full.
 * ponytail: one question per payment per pass; a shop with hundreds waiting would want a batch call.
 */
export async function confirmQrPayments(clientId: string): Promise<number> {
  const waiting = await prisma.payment.findMany({
    where: { clientId, method: 'UPI', status: 'NEEDS_CHECKING', qrId: { not: null } },
    select: { id: true, saleId: true, amountPaise: true, qrId: true },
    take: 20
  });
  let settled = 0;
  for (const p of waiting) {
    const s = await qrStatus(clientId, p.qrId!);
    if (s.status !== 'PAID' || s.paidPaise !== p.amountPaise || !(s.utr || s.paymentId)) continue;
    await prisma.$transaction(async (tx) => {
      const saved = await tx.payment.update({
        where: { id: p.id },
        data: { status: 'COLLECTED', reference: s.utr ?? s.paymentId, checkedAt: new Date(), checkedNote: 'Confirmed by Razorpay' },
        select: { method: true, amountPaise: true, reference: true, status: true }
      });
      await refreshMoneyStatus(tx, p.saleId);
      await paymentUpdated(tx, clientId, p.saleId, p.id, [saved]);
    });
    settled++;
  }
  return settled;
}
