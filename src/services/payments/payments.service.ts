import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { rupees, changeDue } from '../money';
import { PaymentInput } from '../sale/sale.schema';

/**
 * The rules about money coming in. POS-PAY-005..011, POS-SET-003.
 *
 * Its own folder rather than more lines inside the sale, because these rules apply in three places
 * that are otherwise unrelated: taking payment at the counter, collecting a balance later against a
 * kept order (Phase 5), and refunding on a return (Phase 6). One place to change them.
 *
 * THE RULE THAT MATTERS MOST, and it is not about correctness, it is about trust:
 *
 *     NEVER TREAT AN AMBIGUOUS PAYMENT AS FAILED AND ASK THE CUSTOMER TO PAY AGAIN.
 *
 * A UPI transfer the shop's phone has not announced yet may well have arrived. Asking for it twice
 * is worse than a slow till and worse than a wrong total, because to the customer it looks like
 * the shop is trying it on. So uncertainty gets its own state, the sale completes, and someone
 * checks the bank afterwards.
 */

/** Which methods need a reference to be worth anything afterwards. */
const NEEDS_REFERENCE: PaymentMethod[] = ['UPI', 'CARD'];

export interface PlannedPayment {
  method: PaymentMethod;
  amountPaise: number;
  reference: string | null;
  tenderedPaise: number | null;
  changePaise: number | null;
  status: PaymentStatus;
}

/**
 * How much the payments have to come to.
 *
 *   EXACT    a normal sale -- the whole bill, to the paisa
 *   ADVANCE  keeping goods for a customer (POS-ORD-002) -- anything from nothing up to the bill.
 *            Nothing is allowed: a trusted regular leaving a blouse to be stitched may pay the
 *            lot on collection, and forcing a token advance only teaches cashiers to type "1".
 *   COLLECT  money coming in later against a kept order (POS-ORD-012) -- something, but never
 *            more than is still owed. Taking more than the balance is taking money nobody owes.
 */
export type PaymentMode = 'EXACT' | 'ADVANCE' | 'COLLECT';

/**
 * Check a set of payments against what is owed, and say what should be written.
 *
 * Pure: no database, no clock. The caller hands it the figure it actually priced, and gets back
 * either rows to write or an error a cashier can read. That makes every rule below testable
 * without a sale, which is why they are all covered by cases rather than by hope.
 */
export function planPayments(
  totalPaise: number,
  payments: PaymentInput[],
  enabledMethods: PaymentMethod[],
  mode: PaymentMode = 'EXACT'
): PlannedPayment[] {
  if (payments.length === 0 && mode !== 'ADVANCE') throw badRequest('Nothing has been paid.');

  // POS-SET-003. A shop that has turned card off should not be able to take one by any route,
  // including an older till that still shows the button.
  //
  // Store credit is not a method a shop turns on or off: it is the customer's own money, given by
  // an earlier return, and whether it can be spent is decided by their balance.
  for (const payment of payments) {
    if (payment.method === 'CREDIT') continue;
    if (enabledMethods.length > 0 && !enabledMethods.includes(payment.method)) {
      throw badRequest(`This shop is not set up to take ${pretty(payment.method)}.`);
    }
  }

  const paid = payments.reduce((sum, p) => sum + p.amountPaise, 0);

  /*
   * POS-PAY-007. The amounts have to fit what is owed -- and every message says which way it is
   * out and by how much, because "amount mismatch" leaves a cashier doing arithmetic with a queue
   * waiting.
   */
  if (mode === 'EXACT' && paid !== totalPaise) {
    const difference = Math.abs(totalPaise - paid);
    throw conflict(
      paid < totalPaise
        ? `${rupees(difference)} still to pay on a ${rupees(totalPaise)} bill.`
        : `That is ${rupees(difference)} more than the ${rupees(totalPaise)} bill.`,
      { code: 'AMOUNT_MISMATCH', totalPaise, paidPaise: paid, differencePaise: totalPaise - paid }
    );
  }

  if (mode === 'ADVANCE' && paid > totalPaise) {
    throw conflict(
      `An advance of ${rupees(paid)} is more than the ${rupees(totalPaise)} bill.`,
      { code: 'AMOUNT_MISMATCH', totalPaise, paidPaise: paid, differencePaise: totalPaise - paid }
    );
  }

  if (mode === 'COLLECT' && paid > totalPaise) {
    throw conflict(
      `Only ${rupees(totalPaise)} is still owed on this order.`,
      { code: 'OVERPAYMENT', owedPaise: totalPaise, paidPaise: paid }
    );
  }

  return payments.map(payment => {
    const isCash = payment.method === 'CASH';

    if (isCash && payment.tenderedPaise !== undefined && payment.tenderedPaise !== null) {
      if (payment.tenderedPaise < payment.amountPaise) {
        throw badRequest(
          `Only ${rupees(payment.tenderedPaise)} was handed over for a ${rupees(payment.amountPaise)} payment.`
        );
      }
    }

    /*
     * A reference is required for UPI and card ONLY when the payment is being recorded as
     * collected. An unconfirmed one is unconfirmed precisely because the cashier has nothing to
     * write down yet -- demanding the reference there would force them to either invent one or
     * mark a real payment as failed, and the second is the thing this whole file exists to prevent.
     */
    const status: PaymentStatus = payment.unconfirmed ? 'NEEDS_CHECKING' : 'COLLECTED';

    if (NEEDS_REFERENCE.includes(payment.method) && status === 'COLLECTED') {
      const reference = (payment.reference ?? '').trim();
      if (!reference) {
        throw badRequest(
          `Add the ${pretty(payment.method)} reference, or mark it as not confirmed yet.`,
          { code: 'REFERENCE_REQUIRED', method: payment.method }
        );
      }
    }

    // Cash cannot be uncertain: it is either in the drawer or it is not, and the person holding it
    // is standing there. Allowing it would give a cashier a way to record money they never took.
    if (isCash && status === 'NEEDS_CHECKING') {
      throw badRequest('Cash is either taken or it is not. Only UPI and card can be left to check.');
    }
    // The same for store credit: the balance is right here, so there is nothing to check later.
    if (payment.method === 'CREDIT' && status === 'NEEDS_CHECKING') {
      throw badRequest('Store credit is either there or it is not. Only UPI and card can be left to check.');
    }

    return {
      method: payment.method,
      amountPaise: payment.amountPaise,
      reference: payment.reference?.trim() || null,
      tenderedPaise: isCash ? payment.tenderedPaise ?? null : null,
      changePaise: isCash && payment.tenderedPaise != null
        ? changeDue(payment.tenderedPaise, payment.amountPaise)
        : null,
      status
    };
  });
}

/**
 * Bring a sale's money status back in line with its payments.
 *
 * `Sale.status` is a stored summary of the payments -- BALANCE_DUE or COMPLETED -- so the Orders
 * screen can filter on it. A stored summary drifts the moment the thing it summarises changes, and
 * payments DO change after a sale: a balance is collected later, or an unconfirmed UPI is checked
 * and turns out never to have arrived. Before this existed, that second case left a customer owing
 * money on a bill that still said COMPLETED -- found while writing the Orders screen, not reported.
 *
 * So every path that changes a payment calls this, inside its own transaction. One function, so
 * the rule for "is anything owed" lives in one place (owedPaise) and cannot be restated wrongly.
 *
 * A RETURNED or PENDING_SYNC sale is left alone: those statuses are about something other than
 * money, and a payment arriving does not undo a return.
 */
export async function refreshMoneyStatus(tx: Prisma.TransactionClient, saleId: string) {
  const sale = await tx.sale.findUnique({
    where: { id: saleId },
    select: { status: true, totalPaise: true, payments: { select: { amountPaise: true, status: true } } }
  });
  if (!sale || sale.status === 'RETURNED' || sale.status === 'PENDING_SYNC') return sale?.status;

  const next = owedPaise(sale.totalPaise, sale.payments) > 0 ? 'BALANCE_DUE' : 'COMPLETED';
  if (next !== sale.status) {
    await tx.sale.update({ where: { id: saleId }, data: { status: next } });
  }
  return next;
}

/** How much of a bill is actually in hand, ignoring anything still being checked. */
export function collectedPaise(payments: { amountPaise: number; status: PaymentStatus }[]) {
  return payments
    .filter(p => p.status === 'COLLECTED')
    .reduce((sum, p) => sum + p.amountPaise, 0);
}

/**
 * What the customer genuinely still owes on a bill. POS-ORD-003.
 *
 * NOT simply "total minus collected". A payment still being CHECKED is excluded from what is owed
 * as well, because the customer believes they paid it -- and showing it as due would put it on the
 * Orders screen as something to ask them for, which is exactly what Phase 2's rule forbids. It is
 * the bank's question, not the customer's.
 *
 * A VOID payment does count as owed again: it was checked, and the money never arrived.
 */
export function owedPaise(
  totalPaise: number,
  payments: { amountPaise: number; status: PaymentStatus }[]
) {
  const inOrPending = payments
    .filter(p => p.status === 'COLLECTED' || p.status === 'NEEDS_CHECKING')
    .reduce((sum, p) => sum + p.amountPaise, 0);
  return Math.max(0, totalPaise - inOrPending);
}

export interface UncheckedPayment {
  id: string;
  saleId: string;
  invoiceNo: string;
  method: PaymentMethod;
  amountPaise: number;
  reference: string | null;
  createdAt: Date;
}

/**
 * Everything still waiting to be checked against the bank. POS-PAY-011.
 *
 * This list is the whole point of the NEEDS_CHECKING state. A state nobody ever looks at is just a
 * quieter way of losing the money, so it surfaces on its own screen and in the day close.
 */
export async function awaitingCheck(actor: Actor): Promise<UncheckedPayment[]> {
  const rows = await prisma.payment.findMany({
    where: { clientId: actor.clientId, status: 'NEEDS_CHECKING' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, saleId: true, method: true, amountPaise: true, reference: true, createdAt: true,
      sale: { select: { invoiceNo: true } }
    }
  });
  return rows.map(r => ({
    id: r.id,
    saleId: r.saleId,
    invoiceNo: r.sale.invoiceNo,
    method: r.method,
    amountPaise: r.amountPaise,
    reference: r.reference,
    createdAt: r.createdAt
  }));
}

/**
 * Resolve one. POS-PAY-011.
 *
 * `arrived` is the answer the person got from the bank, not a guess. Either it is COLLECTED with a
 * reference they can now write down, or it is VOID and the bill is genuinely short.
 *
 * Only a NEEDS_CHECKING payment can be resolved. A COLLECTED one cannot be quietly turned into a
 * VOID from this path -- that would be a way to make money disappear from a closed bill without an
 * audit trail, which is a different feature (POS-SALE-012, Phase 6) with different rules.
 */
export async function resolve(
  actor: Actor,
  paymentId: string,
  input: { arrived: boolean; reference?: string; note?: string }
) {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, clientId: actor.clientId },
    select: { id: true, status: true, method: true, amountPaise: true, saleId: true }
  });
  if (!payment) throw notFound('That payment was not found.');

  if (payment.status !== 'NEEDS_CHECKING') {
    throw conflict(
      payment.status === 'COLLECTED'
        ? 'That payment is already confirmed.'
        : 'That payment was already written off.',
      { code: 'ALREADY_RESOLVED', status: payment.status }
    );
  }

  const data: Prisma.PaymentUpdateInput = {
    status: input.arrived ? 'COLLECTED' : 'VOID',
    checkedAt: new Date(),
    checkedNote: input.note?.trim() || null,
    ...(actor.id ? { checkedBy: { connect: { id: actor.id } } } : {})
  };
  if (input.arrived && input.reference?.trim()) data.reference = input.reference.trim();

  /*
   * The payment and the sale's money status change together. Checking a UPI and finding it never
   * arrived means the customer owes that money again, and the bill has to say so -- otherwise the
   * Orders screen shows nothing due on a bill that is short.
   */
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data });
    await refreshMoneyStatus(tx, payment.saleId);
  });

  return {
    status: input.arrived ? ('COLLECTED' as const) : ('VOID' as const),
    amountPaise: payment.amountPaise
  };
}

export const pretty = (m: PaymentMethod) => ({
  CASH: 'cash', UPI: 'UPI', CARD: 'card',
  CREDIT: 'store credit', POINTS: 'points', BALANCE: 'balance', EXCHANGE: 'exchange'
}[m] ?? m);
