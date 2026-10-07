import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { conflict, badRequest } from '../../utils/httpError';
import { call } from './client';

/**
 * Points and store credit at the till. Contract §10.
 *
 * POINTS ARE MONEY, SO THE SAFE FAILURE IS THE OPPOSITE OF OFFERS. An offer that cannot be checked
 * degrades to the shelf price and nobody is worse off. A balance that cannot be checked must not be
 * spent at all: two tills, or a till and the online shop, would spend the same 500 points twice. So
 * nothing is ever spent from a cached number. Every spend is a HOLD taken in Inventory before the
 * sale is written, CONFIRMED by its own call the moment the sale commits, and RELEASED if the sale
 * does not happen.
 *
 * TAKEN AT COMPLETE, ON THE SERVER. The contract describes the till holding the points as soon as the
 * cashier types them, releasing on park and holding again on recall. Taking the hold here, as the
 * first step of Complete, gives the same guarantee -- nothing is spent without Inventory saying the
 * balance is there -- with nothing to release on park, because a parked bill never held anything.
 * The one thing it costs: if another till spends the same points in the seconds between the wallet
 * read and Complete, this cashier hears it at Complete and takes the rest another way. That is the
 * failure the contract already calls safe.
 *
 * STORE CREDIT BELONGS TO INVENTORY IN A CONNECTED SHOP. The till's own balance was being spent here
 * while Inventory's copy of the same credit stayed whole -- every credit-note refund is written to
 * both -- so a customer could spend it again on the online shop. Connected, the till spends credit
 * only through a hold; its own figure is a cache, refreshed whenever the wallet is read. A shop with
 * no Inventory keeps the till's own ledger exactly as before.
 */

export interface Wallet {
  customerName: string | null;
  customerRef: string | null;
  points: null | {
    balance: number; pointValuePaise: number; minRedeemPoints: number; maxRedeemPercent: number;
    usablePoints: number; usablePaise: number; reason: string | null;
  };
  credit: null | { balancePaise: number; usablePaise: number };
  reason?: string | null;
}
export type WalletResult = { ok: true; wallet: Wallet } | { ok: false; reason: string };

export interface Hold { kind: 'POINTS' | 'CREDIT'; holdId: string; valuePaise: number }

const CANT = 'Points and store credit can\'t be used right now. Take the rest another way.';
const CONFIRM_TIMEOUT_MS = 6_000;

async function liveLink(clientId: string) {
  const link = await prisma.inventoryLink.findUnique({ where: { clientId } });
  if (!link?.connected) return null;
  return link;
}

async function phoneOf(clientId: string, customerId: string) {
  const c = await prisma.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: { phone: true } });
  return c?.phone ?? null;
}

/** Whether this shop's points and credit live in Inventory. */
export async function walletIsInventorys(clientId: string): Promise<boolean> {
  return !!(await liveLink(clientId));
}

/**
 * What this customer may spend on this bill, in Inventory's own arithmetic. Never throws for an
 * answer that is not there: `{ ok: false, reason }` is shown as one line and the till sells on.
 */
export async function walletFor(actor: Actor, customerId: string, billPaise: number): Promise<WalletResult> {
  const link = await liveLink(actor.clientId);
  if (!link) return { ok: false, reason: 'This shop is not connected to Inventory.' };
  if (link.blockedSequence !== null) return { ok: false, reason: CANT };
  const phone = await phoneOf(actor.clientId, customerId);
  if (!phone) return { ok: false, reason: 'This customer has no phone number, so Inventory cannot find their points.' };

  const reply = await call(link, 'GET', `/wallet?customerRef=${encodeURIComponent(phone)}&billPaise=${Math.max(0, Math.round(billPaise))}`, undefined, 8_000);
  if (reply.kind === 'UNREACHABLE' || reply.status !== 200) return { ok: false, reason: CANT };
  const w: Wallet | undefined = reply.body?.data;
  if (!w) return { ok: false, reason: CANT };

  // The till's own figure is a cache in a connected shop. Keep it honest whenever Inventory speaks.
  if (w.credit && Number.isInteger(w.credit.balancePaise)) {
    await prisma.customer.updateMany({ where: { id: customerId, clientId: actor.clientId }, data: { storeCreditPaise: Math.max(0, w.credit.balancePaise) } });
  }
  return { ok: true, wallet: w };
}

/**
 * Hold what this sale spends in points and credit, before anything is written. Throws a sentence the
 * cashier can act on; on any throw, whatever was already held here is let go first.
 *
 * Idempotent on the sale's once-key: a retried Complete gets the same hold back. A key whose hold
 * was released or swept is spent, so a fresh one is used (contract: "must reserve with a new key").
 */
export async function holdForSale(actor: Actor, input: {
  onceKey: string; customerId?: string;
  payments: { method: string; amountPaise: number; points?: number }[];
  madeOfflineAt?: Date;
}): Promise<Hold[]> {
  const pointsRows = input.payments.filter(p => p.method === 'POINTS');
  const creditRows = input.payments.filter(p => p.method === 'CREDIT');
  if (pointsRows.length === 0 && creditRows.length === 0) return [];

  const link = await liveLink(actor.clientId);
  if (!link) {
    if (pointsRows.length) throw badRequest('Points are kept in Inventory, and this shop is not connected to it. Take the payment another way.', { code: 'POINTS_UNAVAILABLE' });
    return []; // A shop with no Inventory spends its own store credit, as it always has.
  }
  if (pointsRows.length > 1 || creditRows.length > 1) throw badRequest('Take points and store credit once each on a bill.');
  if (!input.customerId) throw badRequest('Points and store credit belong to a customer. Add the customer to the bill first.', { code: 'CUSTOMER_REQUIRED' });
  // A sale saved with no connection is never allowed to spend a balance it could not check (§10 rule 3).
  if (input.madeOfflineAt || link.blockedSequence !== null) throw conflict(CANT, { code: 'POINTS_UNAVAILABLE' });
  const phone = await phoneOf(actor.clientId, input.customerId);
  if (!phone) throw badRequest('This customer has no phone number, so Inventory cannot find their points.');

  const billPaise = input.payments.reduce((n, p) => n + p.amountPaise, 0);
  const wanted: { kind: 'POINTS' | 'CREDIT'; amount: number; amountPaise: number }[] = [
    ...pointsRows.map(p => ({ kind: 'POINTS' as const, amount: p.points ?? 0, amountPaise: p.amountPaise })),
    ...creditRows.map(p => ({ kind: 'CREDIT' as const, amount: p.amountPaise, amountPaise: p.amountPaise }))
  ];
  for (const w of wanted) {
    if (!Number.isInteger(w.amount) || w.amount <= 0) throw badRequest(w.kind === 'POINTS' ? 'Say how many points.' : 'Say how much store credit.');
  }

  const held: Hold[] = [];
  try {
    for (const w of wanted) {
      let key = `${input.onceKey}:${w.kind}`.slice(0, 120);
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await call(link, 'POST', '/holds', { idempotencyKey: key, customerRef: phone, kind: w.kind, amount: w.amount, billPaise }, 10_000);
        if (reply.kind === 'UNREACHABLE') throw conflict(CANT, { code: 'POINTS_UNAVAILABLE' });
        const data = reply.body?.data ?? {};
        if (reply.status !== 200) {
          const what = w.kind === 'POINTS' ? 'Points' : 'Store credit';
          throw conflict(`${what} can't be used: ${String(data.detail ?? 'Inventory refused').replace(/[.\s]+$/, '')}. Take the rest another way.`, { code: data.answer ?? 'POINTS_REFUSED' });
        }
        if (data.status === 'RELEASED' || data.status === 'SWEPT') { key = `${input.onceKey}:${w.kind}:${Date.now()}`.slice(0, 120); continue; }
        held.push({ kind: w.kind, holdId: String(data.holdId), valuePaise: Number(data.valuePaise) });
        // The payment row must carry what the hold is worth -- not a figure the screen worked out.
        if (Number(data.valuePaise) !== w.amountPaise) {
          throw conflict(`Inventory values these ${w.kind === 'POINTS' ? 'points' : 'credit'} at Rs ${(Number(data.valuePaise) / 100).toFixed(2)}, not Rs ${(w.amountPaise / 100).toFixed(2)}. Check the wallet again.`, { code: 'HOLD_VALUE_CHANGED', valuePaise: Number(data.valuePaise) });
        }
        break;
      }
      if (!held.find(h => h.kind === w.kind)) throw conflict(CANT, { code: 'POINTS_UNAVAILABLE' });
    }
    return held;
  } catch (error) {
    await releaseHolds(actor.clientId, held);
    throw error;
  }
}

/** Let go of holds for a sale that did not happen. Best effort: an unconfirmed hold is swept anyway. */
export async function releaseHolds(clientId: string, holds: Hold[]) {
  if (holds.length === 0) return;
  const link = await liveLink(clientId);
  if (!link) return;
  for (const h of holds) await call(link, 'DELETE', `/holds/${encodeURIComponent(h.holdId)}`, undefined, 6_000).catch(() => null);
}

/**
 * Confirm one payment's hold. CONFIRMED and gone-for-good are both final; anything else is tried
 * again by the loop, independently of the sale event.
 */
async function confirmOne(link: NonNullable<Awaited<ReturnType<typeof liveLink>>>, p: { id: string; holdId: string; invoiceNo: string; at: Date }): Promise<'CONFIRMED' | 'GONE' | 'RETRY'> {
  const reply = await call(link, 'POST', `/holds/${encodeURIComponent(p.holdId)}/confirm`, { invoiceNo: p.invoiceNo, occurredAt: p.at.toISOString() }, CONFIRM_TIMEOUT_MS);
  if (reply.kind === 'ANSWERED' && reply.status === 200) {
    await prisma.payment.update({ where: { id: p.id }, data: { holdConfirmedAt: new Date() } });
    return 'CONFIRMED';
  }
  const answer = reply.kind === 'ANSWERED' ? reply.body?.data?.answer : null;
  if (answer === 'HOLD_EXPIRED' || answer === 'HOLD_RELEASED' || answer === 'HOLD_UNKNOWN') {
    await prisma.payment.update({ where: { id: p.id }, data: { holdNote: `Inventory answered ${answer}: the customer's points or credit were not used.` } });
    return 'GONE';
  }
  return 'RETRY';
}

/** The moment a sale commits: its holds confirmed, first attempt here. Returns lines for the cashier. */
export async function confirmSaleHolds(clientId: string, saleId: string): Promise<string[]> {
  const link = await liveLink(clientId);
  if (!link) return [];
  const rows = await prisma.payment.findMany({
    where: { saleId, clientId, holdId: { not: null }, holdConfirmedAt: null, holdNote: null },
    select: { id: true, holdId: true, method: true, createdAt: true, sale: { select: { invoiceNo: true } } }
  });
  const notes: string[] = [];
  for (const r of rows) {
    const out = await confirmOne(link, { id: r.id, holdId: r.holdId!, invoiceNo: r.sale.invoiceNo, at: r.createdAt });
    if (out === 'GONE') notes.push(`${r.method === 'POINTS' ? 'Points' : 'Store credit'} could not be confirmed; the customer's balance was not used. The bill stands.`);
  }
  return notes;
}

/** The loop's pass: every hold still waiting for its confirm, until Inventory answers. */
export async function confirmPendingHolds(clientId: string, max = 20) {
  const link = await liveLink(clientId);
  if (!link) return 0;
  const rows = await prisma.payment.findMany({
    where: { clientId, holdId: { not: null }, holdConfirmedAt: null, holdNote: null },
    orderBy: { createdAt: 'asc' }, take: max,
    select: { id: true, holdId: true, createdAt: true, sale: { select: { invoiceNo: true } } }
  });
  let done = 0;
  for (const r of rows) {
    if ((await confirmOne(link, { id: r.id, holdId: r.holdId!, invoiceNo: r.sale.invoiceNo, at: r.createdAt })) !== 'RETRY') done++;
  }
  return done;
}

/**
 * For the two paths that do not take holds -- an exchange's new bill, and money collected later on a
 * kept order. Points there would be spent with nothing held in Inventory (it would never deduct
 * them), and in a connected shop store credit would come off the till's own copy only, leaving
 * Inventory's whole and spendable online. Both are refused in words until those paths carry a hold.
 *
 * ponytail: refusing is the safe stop. Carrying holds on a collection needs Inventory to settle them
 * from payment.updated, which is not agreed yet.
 */
export async function refuseUnheldBalances(clientId: string, payments: { method: string }[], where: string) {
  if (payments.some(p => p.method === 'POINTS')) {
    throw badRequest(`Points are spent on a new bill at the till, not on ${where}. Take this payment another way.`, { code: 'POINTS_UNAVAILABLE' });
  }
  if (payments.some(p => p.method === 'CREDIT') && await walletIsInventorys(clientId)) {
    throw badRequest(`This shop's store credit is kept in Inventory, and can't be taken on ${where} yet. Take this payment another way.`, { code: 'CREDIT_UNAVAILABLE' });
  }
}
