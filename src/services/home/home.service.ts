import { SaleStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { openShifts } from '../shifts';
import { needsAttention, NeedsAttention } from '../orders';

/**
 * What matters right now. POS-HOME-002, -003, -006, -007.
 *
 * Home is not a dashboard. It answers three questions a shop owner actually asks when they open the
 * app -- how are we doing today, is anything waiting for me, and is the software working -- and
 * gives one obvious primary action. MASTER.md forbids turning this into a BI surface.
 *
 * TWO TILES ARE DELIBERATELY ABSENT. POS-HOME-004 (orders needing attention) and POS-HOME-005
 * (shift status) are approved P0 features whose data does not exist until Phases 5 and 7. They are
 * recorded BLOCKED in FEATURES.md and omitted here rather than shown as a confident zero: "0 orders
 * waiting" and "no orders feature yet" look identical on a screen and mean opposite things. The
 * response says which sections it can answer, so the screen hides what it cannot.
 */

export interface HomeSummary {
  greeting: 'morning' | 'afternoon' | 'evening';
  today: {
    date: string;
    salesPaise: number;
    billCount: number;
    /** Phase 6. Money and credit that went back today, whichever day the bill was from. */
    returnsPaise: number;
    returnCount: number;
  };
  activity: {
    id: string;
    kind: 'SALE' | 'RETURN';
    invoiceNo: string;
    totalPaise: number;
    customerName: string | null;
    itemCount: number;
    at: Date;
  }[];
  /** POS-HOME-004. Null only if it could not be worked out -- never a fake zero. */
  orders: NeedsAttention | null;
  /** POS-HOME-005. Every open drawer, and whether any was left open overnight (POS-SHIFT-009). */
  shifts: { open: Awaited<ReturnType<typeof openShifts>>; overnight: number };
  /** Which approved sections have data behind them yet. The screen renders only these, so an
   * unbuilt feature is absent rather than faked. */
  available: {
    ordersWaiting: boolean;
    shiftStatus: boolean;
  };
}

/**
 * The shop's trading day, not UTC.
 *
 * A sale at 11pm in Chennai belongs to that day's takings, and a day boundary computed in UTC would
 * move it to tomorrow -- which is a day close that does not match the drawer. Computed from the
 * server's local time, which is why the POS server must run in the shop's region.
 */
function todayRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { start, end };
}

/**
 * The trading date as a label, formatted from LOCAL parts.
 *
 * Not `toISOString().slice(0, 10)`. That converts back to UTC first, so local midnight in Chennai
 * is 18:30 the previous day in UTC and the day's takings get labelled with yesterday's date. Caught
 * by reading the endpoint's output on 27 Sep and seeing it say the 26th.
 */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function greetingFor(hour: number): HomeSummary['greeting'] {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export async function summary(actor: Actor, now = new Date()): Promise<HomeSummary> {
  const { start, end } = todayRange(now);
  /*
   * Every bill issued today, INCLUDING one returned later the same day. The return is counted on
   * its own line below. Leaving a returned bill out of "sales" as well would take it off twice --
   * once by vanishing, once as a return -- and a bill from last week returned today would take it
   * off only once. Sales and returns separately is the only version where both are always right.
   */
  const ofToday = {
    clientId: actor.clientId,
    createdAt: { gte: start, lt: end },
    status: { in: ['COMPLETED', 'BALANCE_DUE', 'RETURNED'] as SaleStatus[] }
  };

  // Side by side rather than one after another. Each is a round trip, and Home is on the path
  // between opening the app and being able to sell.
  const [totals, recent, orders, returnsToday, recentReturns, shiftsOpen] = await Promise.all([
    prisma.sale.aggregate({
      where: ofToday,
      _sum: { totalPaise: true },
      _count: true
    }),
    prisma.sale.findMany({
      where: { clientId: actor.clientId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, invoiceNo: true, totalPaise: true, createdAt: true,
        customer: { select: { name: true } },
        _count: { select: { lines: true } }
      }
    }),
    needsAttention(actor),
    prisma.return.aggregate({
      where: { clientId: actor.clientId, createdAt: { gte: start, lt: end } },
      _sum: { totalPaise: true },
      _count: true
    }),
    prisma.return.findMany({
      where: { clientId: actor.clientId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, creditNoteNo: true, totalPaise: true, createdAt: true,
        customer: { select: { name: true } },
        _count: { select: { lines: true } }
      }
    }),
    openShifts(actor.clientId)
  ]);

  const activity: HomeSummary['activity'] = [
    ...recent.map(sale => ({
      id: sale.id,
      kind: 'SALE' as const,
      invoiceNo: sale.invoiceNo,
      totalPaise: sale.totalPaise,
      customerName: sale.customer?.name ?? null,
      itemCount: sale._count.lines,
      at: sale.createdAt
    })),
    ...recentReturns.map(r => ({
      id: r.id,
      kind: 'RETURN' as const,
      invoiceNo: r.creditNoteNo,
      totalPaise: r.totalPaise,
      customerName: r.customer?.name ?? null,
      itemCount: r._count.lines,
      at: r.createdAt
    }))
  ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 10);

  return {
    greeting: greetingFor(now.getHours()),
    today: {
      date: localDate(start),
      salesPaise: totals._sum?.totalPaise ?? 0,
      billCount: totals._count ?? 0,
      returnsPaise: returnsToday._sum?.totalPaise ?? 0,
      returnCount: returnsToday._count ?? 0
    },
    activity,
    orders,
    shifts: { open: shiftsOpen, overnight: shiftsOpen.filter(s => s.openSinceYesterday).length },
    available: {
      // POS-HOME-004 -- unblocked in Phase 5.
      ordersWaiting: true,
      // POS-HOME-005 -- unblocked in Phase 7.
      shiftStatus: true
    }
  };
}
