import { Prisma, SaleStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, conflict, forbidden } from '../../utils/httpError';
import { record } from '../audit';
import { dayClosed } from '../events';
import { openShifts } from '../shifts';

/**
 * Closing the day. WF-DAY-01. POS-DAY-001..005.
 *
 * One page an owner reads at night: what was sold and how it was paid, what went back, what the
 * drawers should hold and what they were counted at, and anything still unsettled -- shifts left
 * open, payments still being checked, bills not yet synced.
 *
 * A CLOSED DAY IS NEVER EDITED. POS-DAY-005. Closing takes a snapshot of every figure and freezes
 * it. Anything that happens after -- a sale at 9:50 pm after the owner closed at 9:45, a return
 * tomorrow against today's bill -- lands on the day it actually happens, and the closed day shows
 * it as "since closing" rather than quietly changing its numbers. The same rule Inventory's day book
 * follows, so the two keep balancing across the cut-over.
 *
 * THE TRADING DAY IS THE SHOP'S, not UTC. A sale at 11 pm in Chennai belongs to that day. Computed
 * from the server's local time, which is why the POS server must run in the shop's region.
 */

const COUNTED: SaleStatus[] = ['COMPLETED', 'BALANCE_DUE', 'RETURNED'];

/** "2026-09-27" as the shop's day: local midnight to local midnight. */
export function dayRange(date: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!m) throw badRequest('Choose a date.');
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const start = new Date(y, mo, d);
  if (start.getMonth() !== mo || start.getDate() !== d) throw badRequest('That is not a real date.');
  const end = new Date(y, mo, d + 1);
  // The @db.Date column stores a calendar date. Handing Prisma LOCAL midnight would store the day
  // before -- local midnight in Chennai is 18:30 the previous day in UTC. So the key is UTC midnight
  // of the same calendar date.
  const key = new Date(Date.UTC(y, mo, d));
  return { start, end, key };
}

export const todayString = (now = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

export interface DayFigures {
  date: string;
  bills: { count: number; grossPaise: number; discountPaise: number; taxPaise: number; netPaise: number };
  returns: { count: number; totalPaise: number };
  /** POS-DAY-001. Money in, by how it came: CASH, UPI, CARD -- and CREDIT / EXCHANGE, which are not money. */
  paidIn: Record<string, number>;
  /** Money and credit back out on returns, by how it went. */
  paidOut: Record<string, number>;
  /** POS-DAY-003. */
  cash: {
    openingPaise: number;
    salesPaise: number;
    refundsPaise: number;
    inPaise: number;
    outPaise: number;
    /** What the drawers should hold between them. */
    positionPaise: number;
    /** Cash taken or refunded with no shift open. Part of the position, reported on its own. */
    unattributedPaise: number;
    /** From shifts closed today. Null when none was counted yet. */
    countedPaise: number | null;
    variancePaise: number | null;
    shiftsClosed: number;
  };
  /** Payments made today still waiting to be checked against the bank. */
  paymentsToCheck: number;
  /** POS-DAY-004. Sales saved on devices during an outage and not yet sent, as the devices report it. */
  pendingSync: number;
}

/** Everything, added up from the rows, for one trading day. */
export async function figures(actor: Actor, date: string): Promise<DayFigures> {
  const { start, end } = dayRange(date);
  const clientId = actor.clientId;
  const inDay = { gte: start, lt: end };

  const [bills, returns, paidIn, paidOut, shiftsOpened, moves, cashIn, cashOut, closed, toCheck, pending] = await Promise.all([
    prisma.sale.aggregate({
      where: { clientId, createdAt: inDay, status: { in: COUNTED } },
      _count: true,
      _sum: { subtotalPaise: true, discountPaise: true, taxPaise: true, totalPaise: true }
    }),
    prisma.return.aggregate({ where: { clientId, createdAt: inDay }, _count: true, _sum: { totalPaise: true } }),
    prisma.payment.groupBy({
      by: ['method'],
      where: { clientId, createdAt: inDay, status: 'COLLECTED' },
      _sum: { amountPaise: true }
    }),
    prisma.returnRefund.groupBy({ by: ['method'], where: { clientId, createdAt: inDay }, _sum: { amountPaise: true } }),
    prisma.shift.aggregate({ where: { clientId, openedAt: inDay }, _sum: { openingCashPaise: true } }),
    prisma.cashMovement.groupBy({ by: ['direction'], where: { clientId, createdAt: inDay }, _sum: { amountPaise: true } }),
    prisma.payment.aggregate({
      where: { clientId, createdAt: inDay, method: 'CASH', status: 'COLLECTED', shiftId: null },
      _sum: { amountPaise: true }
    }),
    prisma.returnRefund.aggregate({
      where: { clientId, createdAt: inDay, method: 'CASH', shiftId: null },
      _sum: { amountPaise: true }
    }),
    prisma.shift.aggregate({
      where: { clientId, closedAt: inDay },
      _count: true,
      _sum: { countedCashPaise: true, differencePaise: true }
    }),
    prisma.payment.count({ where: { clientId, createdAt: inDay, status: 'NEEDS_CHECKING' } }),
    // POS-DAY-004. What is still on devices, not on the server: sales saved during an outage and
    // not yet sent. Counted from devices seen in the last day -- one that has gone quiet for longer
    // is shown on the Devices screen, not guessed into tonight's figure.
    prisma.device.aggregate({
      where: { clientId, lastSeenAt: { gte: new Date(Date.now() - 86_400_000) } },
      _sum: { pendingCount: true }
    })
  ]);

  const byMethod = (rows: { method: string; _sum: { amountPaise: number | null } }[]) =>
    Object.fromEntries(rows.map(r => [r.method, r._sum.amountPaise ?? 0]));
  const inMap = byMethod(paidIn);
  const outMap = byMethod(paidOut);

  const openingPaise = shiftsOpened._sum.openingCashPaise ?? 0;
  const salesPaise = inMap.CASH ?? 0;
  const refundsPaise = outMap.CASH ?? 0;
  const inPaise = moves.find(m => m.direction === 'IN')?._sum.amountPaise ?? 0;
  const outPaise = moves.find(m => m.direction === 'OUT')?._sum.amountPaise ?? 0;

  return {
    date,
    bills: {
      count: bills._count ?? 0,
      grossPaise: bills._sum.subtotalPaise ?? 0,
      discountPaise: bills._sum.discountPaise ?? 0,
      taxPaise: bills._sum.taxPaise ?? 0,
      netPaise: bills._sum.totalPaise ?? 0
    },
    returns: { count: returns._count ?? 0, totalPaise: returns._sum.totalPaise ?? 0 },
    paidIn: inMap,
    paidOut: outMap,
    cash: {
      openingPaise,
      salesPaise,
      refundsPaise,
      inPaise,
      outPaise,
      positionPaise: openingPaise + salesPaise - refundsPaise + inPaise - outPaise,
      unattributedPaise: (cashIn._sum.amountPaise ?? 0) - (cashOut._sum.amountPaise ?? 0),
      countedPaise: closed._count ? closed._sum.countedCashPaise ?? 0 : null,
      variancePaise: closed._count ? closed._sum.differencePaise ?? 0 : null,
      shiftsClosed: closed._count ?? 0
    },
    paymentsToCheck: toCheck,
    pendingSync: pending._sum.pendingCount ?? 0
  };
}

/**
 * WF-DAY-01 for one date: the live figures, whether it is closed, the frozen snapshot if it is,
 * and what has happened since.
 */
export async function day(actor: Actor, date: string) {
  const { key, end } = dayRange(date);
  const [live, snapshot, shifts] = await Promise.all([
    figures(actor, date),
    prisma.dayClose.findUnique({ where: { clientId_date: { clientId: actor.clientId, date: key } } }),
    openShifts(actor.clientId)
  ]);

  // Shifts that matter to THIS day: opened before it ended and still open.
  const stillOpen = shifts.filter(s => s.openedAt.getTime() < end.getTime());

  let closed = null;
  if (snapshot) {
    const by = snapshot.closedById
      ? await prisma.user.findUnique({ where: { id: snapshot.closedById }, select: { name: true } })
      : null;
    const frozen = snapshot.byMethod as unknown as { figures: DayFigures; earlier?: { revision: number; closedAt: string; closedById: string | null; note: string | null; figures: DayFigures }[] };
    // What changed after closing, said separately -- never folded into the closed numbers.
    const since = {
      bills: live.bills.count - frozen.figures.bills.count,
      netPaise: live.bills.netPaise - frozen.figures.bills.netPaise,
      returnsPaise: live.returns.totalPaise - frozen.figures.returns.totalPaise
    };
    closed = {
      closedAt: snapshot.closedAt,
      closedBy: by?.name ?? null,
      note: snapshot.note,
      openShiftsAtClose: snapshot.openShiftsAtClose,
      figures: frozen.figures,
      revision: snapshot.revision,
      // The earlier closes of this day, oldest first: when, by whom, why, and what they said then.
      earlier: await Promise.all((frozen.earlier ?? []).map(async e => ({
        revision: e.revision, closedAt: e.closedAt, note: e.note,
        closedBy: e.closedById ? (await prisma.user.findUnique({ where: { id: e.closedById }, select: { name: true } }))?.name ?? null : null,
        netPaise: e.figures.bills.netPaise, bills: e.figures.bills.count
      }))),
      since: since.bills !== 0 || since.netPaise !== 0 || since.returnsPaise !== 0 ? since : null
    };
  }

  return {
    date,
    isToday: date === todayString(),
    mayClose: may(actor, PERMISSIONS.CLOSE_DAY),
    live,
    openShifts: stillOpen,
    closed
  };
}

/**
 * Close it. POS-DAY-005.
 *
 * Refused while a shift is still open, unless the person closing says, in so many words, that
 * they are closing anyway -- the same shape as handing over an order with money owed. The count of
 * shifts left open is kept on the close.
 */
export async function closeDay(actor: Actor, date: string, input: { acceptOpenShifts?: boolean; note?: string; again?: boolean } = {}) {
  if (!may(actor, PERMISSIONS.CLOSE_DAY)) {
    throw forbidden('Only a manager or the owner can close the day.', { code: 'NOT_PERMITTED' });
  }
  const { key, start, end } = dayRange(date);
  if (start.getTime() > Date.now()) throw badRequest('That day has not happened yet.');

  const existing = await prisma.dayClose.findUnique({
    where: { clientId_date: { clientId: actor.clientId, date: key } }
  });
  if (existing && !input.again) throw await alreadyClosed(existing);
  /*
   * CLOSING AGAIN (7 Oct, asked for by the owner): a late customer after the day was closed. The day
   * is closed afresh with every bill in it, and the earlier close is KEPT -- figures, who, when, note
   * -- not overwritten. It says why, and only when something has actually changed since.
   */
  if (existing && input.again && (input.note ?? '').trim().length < 4) {
    throw badRequest('Say why the day is being closed again — for example, "late customer after closing".', { code: 'REASON_REQUIRED' });
  }

  const stillOpen = (await openShifts(actor.clientId)).filter(s => s.openedAt.getTime() < end.getTime());
  if (stillOpen.length > 0 && !input.acceptOpenShifts) {
    const names = stillOpen.map(s => `${s.counterName}${s.openedBy ? ` (${s.openedBy})` : ''}`).join(', ');
    throw conflict(
      `${stillOpen.length === 1 ? 'A shift is' : `${stillOpen.length} shifts are`} still open: ${names}. Close ${stillOpen.length === 1 ? 'it' : 'them'} first, or confirm you are closing the day anyway.`,
      { code: 'OPEN_SHIFTS', shifts: stillOpen.map(s => ({ id: s.id, counterName: s.counterName, openedBy: s.openedBy })) }
    );
  }

  const live = await figures(actor, date);

  if (existing && input.again) {
    const frozen = existing.byMethod as unknown as { figures: DayFigures; earlier?: unknown[] };
    const unchanged = live.bills.count === frozen.figures.bills.count && live.bills.netPaise === frozen.figures.bills.netPaise
      && live.returns.totalPaise === frozen.figures.returns.totalPaise;
    if (unchanged) throw conflict('Nothing has changed since the day was closed, so there is nothing to close again.', { code: 'NOTHING_NEW' });
    const revision = existing.revision + 1;
    await prisma.$transaction(async (tx) => {
      // Guarded on the revision read: two managers closing again at once -- one wins, one is told.
      const r = await tx.dayClose.updateMany({
        where: { id: existing.id, revision: existing.revision },
        data: {
          ...columnsOf(live, stillOpen.length),
          revision,
          byMethod: {
            figures: live,
            earlier: [...(frozen.earlier ?? []), { revision: existing.revision, closedAt: existing.closedAt, closedById: existing.closedById, note: existing.note, figures: frozen.figures }]
          } as unknown as Prisma.InputJsonValue,
          note: input.note!.trim(),
          closedById: actor.kind === 'USER' ? actor.id : null,
          closedAt: new Date()
        }
      });
      if (r.count === 0) throw conflict('Someone else closed this day again a moment ago. Look at it again.', { code: 'RECLOSED_MEANWHILE' });
      await dayClosed(tx, actor.clientId, date, {
        revision, replaces: existing.revision,
        bills: live.bills, returns: live.returns, paidIn: live.paidIn, paidOut: live.paidOut,
        cash: live.cash, openShiftsAtClose: stillOpen.length, note: input.note!.trim()
      });
    });
    await record(actor, {
      action: 'day.reclosed',
      subject: date,
      detail: { revision, reason: input.note!.trim(), netWasPaise: frozen.figures.bills.netPaise, netNowPaise: live.bills.netPaise, billsWas: frozen.figures.bills.count, billsNow: live.bills.count }
    });
    return day(actor, date);
  }

  try {
    // The close and its event together: an accountant's software is told about exactly the closes
    // that happened. POS-API-007, POS-WEB-001.
    await prisma.$transaction(async (tx) => {
    await tx.dayClose.create({
      data: {
        clientId: actor.clientId,
        date: key,
        ...columnsOf(live, stillOpen.length),
        // The whole picture, frozen as it was read. The columns above are for querying across days;
        // this is what the closed day shows, so it can never be re-derived differently later.
        byMethod: { figures: live } as unknown as Prisma.InputJsonValue,
        note: input.note?.trim() || null,
        closedById: actor.kind === 'USER' ? actor.id : null
      }
    });
    await dayClosed(tx, actor.clientId, date, {
      bills: live.bills, returns: live.returns, paidIn: live.paidIn, paidOut: live.paidOut,
      cash: live.cash, openShiftsAtClose: stillOpen.length, note: input.note?.trim() || null
    });
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const winner = await prisma.dayClose.findUnique({
        where: { clientId_date: { clientId: actor.clientId, date: key } },
        select: { closedAt: true, closedById: true }
      });
      if (winner) throw await alreadyClosed(winner);
    }
    throw error;
  }

  await record(actor, {
    action: 'day.closed',
    subject: date,
    detail: {
      netPaise: live.bills.netPaise,
      returnsPaise: live.returns.totalPaise,
      cashPositionPaise: live.cash.positionPaise,
      variancePaise: live.cash.variancePaise,
      openShiftsAtClose: stillOpen.length
    }
  });

  return day(actor, date);
}

/** The day's figures as the queryable columns of its close. One place, for a first close and a later one. */
function columnsOf(live: DayFigures, openShiftsAtClose: number) {
  return {
    salesCount: live.bills.count,
    grossPaise: live.bills.grossPaise,
    discountPaise: live.bills.discountPaise,
    taxPaise: live.bills.taxPaise,
    netPaise: live.bills.netPaise,
    returnsPaise: live.returns.totalPaise,
    returnsCount: live.returns.count,
    cashPositionPaise: live.cash.positionPaise,
    openingCashPaise: live.cash.openingPaise,
    cashInPaise: live.cash.inPaise,
    cashOutPaise: live.cash.outPaise,
    countedCashPaise: live.cash.countedPaise,
    variancePaise: live.cash.variancePaise,
    unattributedCashPaise: live.cash.unattributedPaise,
    openShiftsAtClose,
    paymentsToCheck: live.paymentsToCheck
  };
}

async function alreadyClosed(row: { closedAt: Date; closedById: string | null }) {
  const by = row.closedById ? await prisma.user.findUnique({ where: { id: row.closedById }, select: { name: true } }) : null;
  const at = row.closedAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return conflict(
    `This day was already closed${by?.name ? ` by ${by.name}` : ''} at ${at}. Anything since shows on its own line; use Close again to take it in.`,
    { code: 'ALREADY_CLOSED' }
  );
}
