import { Fulfilment, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor, PERMISSIONS, may } from '../../types/actor';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { literal, phoneDigits } from '../../utils/likeText';
import { rupees } from '../money';
import { planPayments, owedPaise, refreshMoneyStatus, duplicateReferences, duplicateMessage } from '../payments';
import { grant } from '../approvals';
import { PaymentInput } from '../sale/sale.schema';
import { record } from '../audit';
import { spendCredit } from '../store-credit';
import { shiftFor } from '../shifts';
import { paymentUpdated } from '../events';
import { refuseUnheldBalances } from '../inventory-link/holds.service';
import { verifyQrPayments } from '../inventory-link/upi-qr.service';

/**
 * Orders: goods kept for a customer, money still owed, things to hand over. POS-ORD-001..014.
 *
 * ONE WORD FOR THE USER, SEVERAL THINGS UNDERNEATH. A shop does not think in "kept sales with a
 * BALANCE_DUE status and a READY fulfilment state". It thinks "Priya's blouse is ready and she
 * still owes 800". So the screen has four tabs -- Waiting, Ready, Due, Complete -- and they are
 * FILTERS over two independent facts rather than four states a record moves between:
 *
 *     the goods    WAITING -> READY -> HANDED_OVER        (Sale.fulfilment)
 *     the money    BALANCE_DUE or COMPLETED               (Sale.status, kept in step by
 *                                                          refreshMoneyStatus)
 *
 * An order can be Ready and Due at once, and appears under both. That is the truth, and a single
 * state machine would have to lie about one or the other.
 *
 * Only KEPT sales are orders. A counter sale is handed over the moment it is made.
 */

export type OrderTab = 'ALL' | 'WAITING' | 'READY' | 'DUE' | 'COMPLETE';

/**
 * Open orders are few -- dozens in a busy saree shop, not thousands -- so the list is capped rather
 * than paged. The COMPLETE tab is history, which grows forever, and is newest-first with the same
 * cap; older completed orders are found in Bills, which does page.
 */
const LIMIT = 100;

export interface OrderRow {
  id: string;
  /** Owed money the shop gave up on -- shown as written off, never as paid. */
  writtenOffPaise: number;
  invoiceNo: string;
  customerName: string | null;
  customerPhone: string | null;
  itemCount: number;
  totalPaise: number;
  owedPaise: number;
  fulfilment: Fulfilment;
  promisedAt: Date | null;
  /** Promised for a day that has passed, and still not handed over. */
  overdue: boolean;
  note: string | null;
  createdAt: Date;
}

const ROW_SELECT = {
  id: true, invoiceNo: true, totalPaise: true, fulfilment: true, promisedAt: true,
  note: true, createdAt: true,
  customer: { select: { name: true, phone: true } },
  payments: { select: { amountPaise: true, status: true } },
  _count: { select: { lines: true } }
} as const;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function toRow(sale: any): OrderRow {
  const today = startOfToday();
  return {
    id: sale.id,
    invoiceNo: sale.invoiceNo,
    customerName: sale.customer?.name ?? null,
    customerPhone: sale.customer?.phone ?? null,
    itemCount: sale._count.lines,
    totalPaise: sale.totalPaise,
    owedPaise: owedPaise(sale.totalPaise, sale.payments),
    writtenOffPaise: sale.payments.filter((p: any) => p.status === 'WRITTEN_OFF').reduce((n: number, p: any) => n + p.amountPaise, 0),
    fulfilment: sale.fulfilment,
    promisedAt: sale.promisedAt,
    overdue: Boolean(sale.promisedAt && sale.promisedAt < today && sale.fulfilment !== 'HANDED_OVER'),
    note: sale.note,
    createdAt: sale.createdAt
  };
}

/** WF-ORDERS-01. POS-ORD-006..010. */
export async function list(actor: Actor, tab: OrderTab = 'ALL', rawQuery?: unknown): Promise<OrderRow[]> {
  const where: Prisma.SaleWhereInput = { clientId: actor.clientId, kind: 'KEPT' };

  // A kept order that was returned before collection is not waiting for anything any more.
  if (tab === 'WAITING') { where.fulfilment = 'WAITING'; where.status = { not: 'RETURNED' }; }
  if (tab === 'READY') { where.fulfilment = 'READY'; where.status = { not: 'RETURNED' }; }
  if (tab === 'DUE') where.status = 'BALANCE_DUE';
  if (tab === 'COMPLETE') { where.fulfilment = 'HANDED_OVER'; where.status = 'COMPLETED'; }

  const q = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 60) : '';
  if (q) {
    const digits = phoneDigits(q);
    where.OR = [
      { invoiceNo: { contains: literal(q), mode: 'insensitive' } },
      { customer: { name: { contains: literal(q), mode: 'insensitive' } } },
      ...(digits ? [{ customer: { phone: { contains: digits } } }] : [])
    ];
  }

  /*
   * An open worklist is sorted by when it is promised, soonest first -- that is the order a shop
   * works through it in. An order with no date sinks below the dated ones. History is newest first.
   */
  const open = tab === 'WAITING' || tab === 'READY' || tab === 'DUE';
  const rows = await prisma.sale.findMany({
    where,
    select: ROW_SELECT,
    orderBy: open
      ? [{ promisedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]
      : [{ createdAt: 'desc' }],
    take: LIMIT
  });
  return rows.map(toRow);
}

/** Load one kept order, or explain why it is not one. */
async function loadOrder(db: Prisma.TransactionClient | typeof prisma, actor: Actor, saleId: string) {
  const sale = await db.sale.findFirst({
    where: { id: saleId, clientId: actor.clientId },
    select: {
      id: true, kind: true, status: true, fulfilment: true, totalPaise: true, invoiceNo: true,
      customerId: true,
      payments: { select: { amountPaise: true, status: true } }
    }
  });
  if (!sale) throw notFound('That order was not found.');
  if (sale.kind !== 'KEPT') {
    throw badRequest('That bill was paid for and taken at the counter, so there is nothing to collect or hand over.');
  }
  if (sale.status === 'RETURNED') throw conflict('That order was returned.');
  return sale;
}

/**
 * Take a row lock on the sale for the rest of the transaction.
 *
 * Two cashiers collecting the same balance at the same moment each read "800 owed", each take 800,
 * and the customer has paid 1,600 for an 800 debt. Reading the balance and writing the payment has
 * to be one step, so the balance is read AFTER this lock and nobody else can read it until the
 * transaction ends.
 */
async function lock(tx: Prisma.TransactionClient, saleId: string) {
  await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId} FOR UPDATE`;
}

/**
 * Collect money against a kept order. POS-ORD-012, POS-PAY-014.
 *
 * Partial or full, by any method the shop takes, including a UPI marked unconfirmed. Never more
 * than is owed. Idempotent on `onceKey`, so a double press or a retry after a timeout records the
 * money once.
 */
export async function collect(
  actor: Actor,
  saleId: string,
  input: { onceKey: string; payments: PaymentInput[]; counterId?: string; approval?: { pin: string; reason: string } }
) {
  if (!input.onceKey || input.onceKey.length < 8) throw badRequest('This collection needs a key.');
  input = { ...input, payments: await verifyQrPayments(actor.clientId, input.payments) };
  await refuseUnheldBalances(actor.clientId, input.payments, 'money collected on an order');

  // Already recorded -- the second press of the same button. Return the order as it stands.
  const already = await prisma.payment.findFirst({
    where: { clientId: actor.clientId, onceKey: `${input.onceKey}:pay:0` },
    select: { saleId: true }
  });
  if (already) {
    if (already.saleId !== saleId) {
      throw conflict('That payment was already recorded against a different order.');
    }
    return { replayed: true, ...(await summary(actor, saleId)) };
  }

  await prisma.$transaction(async (tx) => {
    await lock(tx, saleId);
    const order = await loadOrder(tx, actor, saleId);

    const owed = owedPaise(order.totalPaise, order.payments);
    /*
     * A balance written off and then paid after all (the customer turns up): it can be taken, up to
     * what was written off, and that much of the write-off goes away. Money is money -- it reaches
     * the drawer and Inventory as an ordinary collection.
     */
    const writtenOff = order.payments.filter(p => p.status === 'WRITTEN_OFF').reduce((n, p) => n + p.amountPaise, 0);
    if (owed === 0 && writtenOff === 0) {
      throw conflict('Nothing is owed on this order.', { code: 'NOTHING_OWED' });
    }

    const settings = await tx.shopSettings.findUnique({
      where: { clientId: actor.clientId }, select: { enabledPaymentMethods: true }
    });
    const planned = planPayments(owed + writtenOff, input.payments, settings?.enabledPaymentMethods ?? [], 'COLLECT');
    // One payment shown twice is stopped here too (PLAN-payments Step 1); a manager may allow it.
    const dupes = await duplicateReferences(tx, actor.clientId, planned);
    if (dupes.length > 0) {
      const detail = { references: dupes };
      if (!input.approval) throw forbidden(duplicateMessage(dupes[0]), { code: 'APPROVAL_REQUIRED', kind: 'DUPLICATE_REFERENCE', ...detail });
      await grant(actor, { kind: 'DUPLICATE_REFERENCE', pin: input.approval.pin, reason: input.approval.reason, detail }, tx);
    }

    const now = new Date();
    // Saturday's balance goes into Saturday's drawer -- whichever is open where it is collected.
    const shiftId = await shiftFor(tx, actor, input.counterId);
    await tx.payment.createMany({
      data: planned.map((payment, index) => ({
        clientId: actor.clientId,
        saleId,
        method: payment.method,
        amountPaise: payment.amountPaise,
        qrId: payment.qrId ?? null,
        reference: payment.reference,
        tenderedPaise: payment.tenderedPaise,
        changePaise: payment.changePaise,
        status: payment.status,
        collectedAt: now,
        shiftId,
        onceKey: `${input.onceKey}:pay:${index}`
      }))
    });

    // POS-PAY-016. A balance can be paid from store credit, taken with the same guarded UPDATE as
    // at the counter. A kept order always has a customer, so there is always someone to take it from.
    const credit = planned.filter(p => p.method === 'CREDIT').reduce((sum, p) => sum + p.amountPaise, 0);
    if (credit > 0) {
      if (!order.customerId) throw badRequest('Store credit belongs to a customer, and this order has none.');
      await spendCredit(tx, actor, order.customerId, credit, { saleId });
    }

    // Whatever came in beyond what was owed un-writes that much of the write-off.
    let undo = planned.reduce((n, p) => n + p.amountPaise, 0) - owed;
    if (undo > 0) {
      for (const row of await tx.payment.findMany({ where: { saleId, status: 'WRITTEN_OFF' }, orderBy: { createdAt: 'desc' }, select: { id: true, amountPaise: true } })) {
        const cut = Math.min(undo, row.amountPaise);
        if (cut === row.amountPaise) await tx.payment.delete({ where: { id: row.id } });
        else await tx.payment.update({ where: { id: row.id }, data: { amountPaise: row.amountPaise - cut } });
        undo -= cut;
        if (undo === 0) break;
      }
    }
    await refreshMoneyStatus(tx, saleId);
    // The balance, as takings for Inventory's day book. One key per collection (the once-key).
    await paymentUpdated(tx, actor.clientId, saleId, input.onceKey, planned);
  });

  return { replayed: false, ...(await summary(actor, saleId)) };
}

/** POS-ORD-007. The goods are ready; the customer can come. */
export async function markReady(actor: Actor, saleId: string) {
  await prisma.$transaction(async (tx) => {
    await lock(tx, saleId);
    const order = await loadOrder(tx, actor, saleId);
    if (order.fulfilment === 'HANDED_OVER') {
      throw conflict('That order was already handed over.');
    }
    // Pressing it twice is not an error -- it was already ready, and it still is.
    if (order.fulfilment === 'READY') return;
    await tx.sale.update({ where: { id: saleId }, data: { fulfilment: 'READY', readyAt: new Date() } });
  });
  return summary(actor, saleId);
}

/**
 * Hand the goods over. POS-ORD-013, -014.
 *
 * With nothing owed, it simply happens. With money still owed, it is refused unless the person at
 * the till says, explicitly, that they are handing over anyway -- and then the amount and the name
 * are recorded. That is the warning the counter sale has shown since 17 Sep 2026, carried across:
 * a shop can trust a regular with a balance, but it should be a decision someone made, not
 * something that happened because a button was pressed.
 *
 * Straight from WAITING is allowed: a customer who arrives early for goods that are, in fact,
 * ready should not wait while someone presses "ready" first.
 */
export async function handOver(actor: Actor, saleId: string, input: { acceptDue?: boolean } = {}) {
  let dueAtHandover = 0;
  let invoiceNo = '';

  await prisma.$transaction(async (tx) => {
    await lock(tx, saleId);
    const order = await loadOrder(tx, actor, saleId);
    invoiceNo = order.invoiceNo;

    if (order.fulfilment === 'HANDED_OVER') {
      throw conflict('That order was already handed over.', { code: 'ALREADY_HANDED_OVER' });
    }

    dueAtHandover = owedPaise(order.totalPaise, order.payments);

    if (dueAtHandover > 0 && !input.acceptDue) {
      throw conflict(
        `${rupees(dueAtHandover)} is still owed on this order. Collect it first, or confirm you are handing over with money due.`,
        { code: 'HANDOVER_WITH_DUE', owedPaise: dueAtHandover }
      );
    }

    await tx.sale.update({
      where: { id: saleId },
      data: {
        fulfilment: 'HANDED_OVER',
        handedOverAt: new Date(),
        handedOverById: actor.kind === 'USER' ? actor.id : null,
        handoverDuePaise: dueAtHandover > 0 ? dueAtHandover : null
      }
    });
  });

  // After commit, per the audit rule: only record what actually happened.
  if (dueAtHandover > 0) {
    await record(actor, {
      action: 'order.handed_over_with_due',
      subject: invoiceNo,
      detail: { owedPaise: dueAtHandover }
    });
  }

  return summary(actor, saleId);
}

/** The figures a screen needs after any change: what is owed now, and where the goods are. */
export async function summary(actor: Actor, saleId: string) {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, clientId: actor.clientId },
    select: ROW_SELECT
  });
  if (!sale) throw notFound('That order was not found.');
  return { order: toRow(sale) };
}

export interface NeedsAttention {
  readyToCollect: number;
  overdue: number;
  dueCount: number;
  duePaise: number;
}

/**
 * POS-HOME-004. What on the Orders screen someone should look at today.
 *
 * Three different reasons to look, reported separately, because "5 orders need attention" tells a
 * shop owner nothing about what to DO: phone the ready ones, chase the late ones, collect the owed.
 */
export async function needsAttention(actor: Actor): Promise<NeedsAttention> {
  const today = startOfToday();
  const [ready, overdue, due] = await Promise.all([
    prisma.sale.count({ where: { clientId: actor.clientId, kind: 'KEPT', fulfilment: 'READY' } }),
    prisma.sale.count({
      where: {
        clientId: actor.clientId, kind: 'KEPT',
        fulfilment: { not: 'HANDED_OVER' },
        promisedAt: { lt: today }
      }
    }),
    prisma.sale.findMany({
      where: { clientId: actor.clientId, kind: 'KEPT', status: 'BALANCE_DUE' },
      select: { totalPaise: true, payments: { select: { amountPaise: true, status: true } } },
      take: 500
    })
  ]);

  return {
    readyToCollect: ready,
    overdue,
    dueCount: due.length,
    duePaise: due.reduce((sum, s) => sum + owedPaise(s.totalPaise, s.payments), 0)
  };
}

/** POS-CUST-011. What one customer owes across all their kept orders. */
export async function owedByCustomer(clientId: string, customerId: string): Promise<number> {
  const orders = await prisma.sale.findMany({
    where: { clientId, customerId, kind: 'KEPT', status: 'BALANCE_DUE' },
    select: { totalPaise: true, payments: { select: { amountPaise: true, status: true } } }
  });
  return orders.reduce((sum, o) => sum + owedPaise(o.totalPaise, o.payments), 0);
}

/**
 * WRITING OFF what a customer will never pay (owner's go-ahead, 8 Oct). The bill and its GST stay
 * exactly as issued -- the goods went, the tax is owed either way. What changes is the debt: a
 * BALANCE row marked WRITTEN_OFF closes it, so the order leaves Due, without pretending money came
 * in (cash, takings and Inventory's day book see nothing). A cashier needs a manager's PIN. A bill
 * with a write-off takes no return: the store credit it would give back was never paid for.
 */
export async function writeOff(
  actor: Actor,
  saleId: string,
  input: { onceKey: string; reason: string; approval?: { pin: string; reason: string } }
) {
  if (!input.onceKey || input.onceKey.length < 8) throw badRequest('This write-off needs a key.');
  const reason = (input.reason ?? '').trim();
  if (reason.length < 3) throw badRequest('Say why the balance is being written off. A few words is enough.', { code: 'REASON_REQUIRED' });

  const already = await prisma.payment.findFirst({ where: { clientId: actor.clientId, onceKey: `${input.onceKey}:off` }, select: { saleId: true } });
  if (already) {
    if (already.saleId !== saleId) throw conflict('That write-off was already recorded against a different order.');
    return { replayed: true, ...(await summary(actor, saleId)) };
  }

  const audit: { subject: string; detail: { invoiceNo: string; owedPaise: number; reason: string } }[] = [];
  await prisma.$transaction(async (tx) => {
    await lock(tx, saleId);
    const order = await loadOrder(tx, actor, saleId);
    if (order.payments.some(p => p.status === 'NEEDS_CHECKING')) {
      throw conflict('A payment on this order is still being checked. Settle it on Payment checks first.', { code: 'PAYMENT_BEING_CHECKED' });
    }
    if (order.fulfilment !== 'HANDED_OVER') {
      throw conflict('The goods are still in the shop. Write off only what went home unpaid.', { code: 'NOT_HANDED_OVER' });
    }
    const owed = owedPaise(order.totalPaise, order.payments);
    if (owed === 0) throw conflict('Nothing is owed on this order.', { code: 'NOTHING_OWED' });

    const detail = { invoiceNo: order.invoiceNo, owedPaise: owed, reason };
    if (!may(actor, PERMISSIONS.WRITE_OFF)) {
      if (!input.approval) {
        throw forbidden('A manager needs to approve writing off what is owed.', { code: 'APPROVAL_REQUIRED', kind: 'WRITE_OFF', owedPaise: owed });
      }
      const granted = await grant(actor, { kind: 'WRITE_OFF', pin: input.approval.pin, reason: input.approval.reason, detail }, tx);
      await tx.approval.update({ where: { id: granted.id }, data: { saleId } });
    }

    await tx.payment.create({
      data: {
        clientId: actor.clientId, saleId, method: 'BALANCE', amountPaise: owed, status: 'WRITTEN_OFF',
        collectedAt: new Date(), onceKey: `${input.onceKey}:off`
      }
    });
    await refreshMoneyStatus(tx, saleId);
    audit.push({ subject: order.invoiceNo, detail });
  });
  for (const a of audit) await record(actor, { action: 'order.written_off', ...a });

  return { replayed: false, ...(await summary(actor, saleId)) };
}
