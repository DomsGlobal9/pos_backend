import { Prisma, SaleStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest } from '../../utils/httpError';
import { dayRange, todayString } from '../day-close';
import { owedPaise } from '../payments';

/**
 * Operational reports. WF-REPORTS-01, POS-RPT-001..011.
 *
 * SMALL ON PURPOSE (MASTER §10 rule 10). These answer the questions a shop owner actually asks --
 * how did we do, how was it paid, who sold it, what went back, what did we give away, what GST do
 * we owe, is the cash right, who owes us -- not a BI tool.
 *
 * EVERY FIGURE IS ADDED UP FROM THE ROWS THAT MADE IT (the Phase 9 gate: "reconcile to source
 * transactions"). Nothing here is a stored total. `verify-reports` builds a day of known bills and
 * checks each section to the paisa, and checks that the sections agree with each other (the
 * cashiers add up to the whole, the counters add up to the whole, the GST lines add up to the bills).
 *
 * WHO SEES WHAT (MASTER §8: operational reports -- owner yes, manager yes, cashier "limited"):
 *   report:view   any period up to 92 days, every cashier and counter, cash, dues, day closes
 *   anyone else   their OWN bills, today only -- how their day is going, nothing about anyone else's
 */

const COUNTED: SaleStatus[] = ['COMPLETED', 'BALANCE_DUE', 'RETURNED'];
const MAX_DAYS = 92;

export interface ReportQuery { from?: string; to?: string }

function period(q: ReportQuery) {
  const from = q.from ?? todayString();
  const to = q.to ?? from;
  const a = dayRange(from);
  const b = dayRange(to);
  if (b.start < a.start) throw badRequest('The end date is before the start date.');
  const days = Math.round((b.start.getTime() - a.start.getTime()) / 86_400_000) + 1;
  if (days > MAX_DAYS) throw badRequest(`Choose ${MAX_DAYS} days or fewer.`);
  return { from, to, days, start: a.start, end: b.end };
}

async function names(ids: (string | null)[], kind: 'user' | 'counter') {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map<string, string>();
  const rows = kind === 'user'
    ? await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })
    : await prisma.counter.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(rows.map(r => [r.id, r.name ?? '']));
}

export async function report(actor: Actor, q: ReportQuery = {}) {
  const full = may(actor, PERMISSIONS.REPORTS);
  // The limited view is fixed: today, your own bills. A cashier asking for last month gets today.
  const p = full ? period(q) : period({ from: todayString(), to: todayString() });
  const clientId = actor.clientId;
  const inRange = { gte: p.start, lt: p.end };
  const mine = full ? {} : { cashierId: actor.id ?? '__nobody__' };
  const saleWhere: Prisma.SaleWhereInput = { clientId, createdAt: inRange, status: { in: COUNTED }, ...mine };

  const [totals, payments, unsettled, refunds, byCashier, byCounter, returns, returnLines, taxLines, overrides, approvals, offered] = await Promise.all([
    // POS-RPT-001
    prisma.sale.aggregate({
      where: saleWhere,
      _count: true,
      _sum: { subtotalPaise: true, discountPaise: true, taxPaise: true, roundOffPaise: true, totalPaise: true }
    }),
    // POS-RPT-002. Money in by method, dated when it was taken -- a balance collected today counts today.
    prisma.payment.groupBy({
      by: ['method'],
      where: { clientId, createdAt: inRange, status: 'COLLECTED', ...(full ? {} : { sale: { cashierId: actor.id ?? '__nobody__' } }) },
      _sum: { amountPaise: true },
      _count: true
    }),
    /*
     * Money that is neither in the drawer nor written off: a UPI still being checked, and one
     * checked and found never to have arrived. "How it was paid" counts only COLLECTED, which is
     * right, but on its own it reads as a fault -- an owner sees "Net sales Rs 24,499" beside
     * "Nothing taken" and reasonably thinks the day's takings have gone (seen on the live till,
     * 5 Oct). Said out loud it is just a bill waiting on the bank.
     */
    prisma.payment.groupBy({
      by: ['status'],
      where: {
        clientId, createdAt: inRange, status: { in: ['NEEDS_CHECKING', 'VOID'] },
        ...(full ? {} : { sale: { cashierId: actor.id ?? '__nobody__' } })
      },
      _sum: { amountPaise: true },
      _count: true
    }),
    prisma.returnRefund.groupBy({
      by: ['method'],
      where: { clientId, createdAt: inRange, ...(full ? {} : { returnRow: { cashierId: actor.id ?? '__nobody__' } }) },
      _sum: { amountPaise: true }
    }),
    // POS-RPT-003, -004
    prisma.sale.groupBy({ by: ['cashierId'], where: saleWhere, _count: true, _sum: { totalPaise: true } }),
    prisma.sale.groupBy({ by: ['counterId'], where: saleWhere, _count: true, _sum: { totalPaise: true } }),
    // POS-RPT-005
    prisma.return.findMany({
      where: { clientId, createdAt: inRange, ...(full ? {} : { cashierId: actor.id ?? '__nobody__' }) },
      select: { totalPaise: true, refundMethod: true, reason: true }
    }),
    prisma.returnLine.findMany({
      where: { returnRow: { clientId, createdAt: inRange, ...(full ? {} : { cashierId: actor.id ?? '__nobody__' }) } },
      select: { amountPaise: true, taxPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, saleLine: { select: { taxRate: true } } }
    }),
    // POS-RPT-007. Per rate, from the lines as they were charged.
    prisma.saleLine.groupBy({
      by: ['taxRate'],
      where: { sale: saleWhere },
      _sum: { lineTotalPaise: true, taxPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true }
    }),
    // POS-RPT-006. Price overrides: what the tag said against what was charged.
    prisma.saleLine.findMany({
      where: { sale: saleWhere, listPricePaise: { not: null } },
      select: { qty: true, unitPricePaise: true, listPricePaise: true }
    }),
    prisma.approval.groupBy({
      by: ['kind'],
      where: { clientId, createdAt: inRange, ...(full ? {} : { requestedById: actor.id ?? '__nobody__' }) },
      _count: true
    }),
    /*
     * The offers' share of the discounts (contract §9). An automatic offer is Inventory's price,
     * not a cashier giving money away, and an owner reading "Discounts given" means the latter.
     * Summed here from the lines' applied offers; a shop's day is a few hundred lines at most.
     */
    prisma.saleLine.findMany({
      where: { sale: saleWhere, appliedOffers: { not: Prisma.DbNull } },
      select: { appliedOffers: true }
    })
  ]);

  const [cashierNames, counterNames] = await Promise.all([
    names(byCashier.map(r => r.cashierId), 'user'),
    names(byCounter.map(r => r.counterId), 'counter')
  ]);

  const net = totals._sum.totalPaise ?? 0;
  const bills = totals._count ?? 0;
  const returnedPaise = returns.reduce((n, r) => n + r.totalPaise, 0);

  // GST: charged on bills, reversed on credit notes, per rate.
  const reversed = new Map<number, { taxable: number; tax: number; cgst: number; sgst: number; igst: number }>();
  for (const l of returnLines) {
    const r = reversed.get(l.saleLine.taxRate) ?? { taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += l.amountPaise - l.taxPaise; r.tax += l.taxPaise; r.cgst += l.cgstPaise; r.sgst += l.sgstPaise; r.igst += l.igstPaise;
    reversed.set(l.saleLine.taxRate, r);
  }
  const rates = [...new Set([...taxLines.map(t => t.taxRate), ...reversed.keys()])].sort((a, b) => a - b);
  const tax = rates.map(rate => {
    const t = taxLines.find(x => x.taxRate === rate)?._sum;
    const back = reversed.get(rate) ?? { taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0 };
    const charged = {
      taxable: (t?.lineTotalPaise ?? 0) - (t?.taxPaise ?? 0),
      tax: t?.taxPaise ?? 0, cgst: t?.cgstPaise ?? 0, sgst: t?.sgstPaise ?? 0, igst: t?.igstPaise ?? 0
    };
    return {
      rate,
      charged,
      reversed: back,
      net: {
        taxable: charged.taxable - back.taxable, tax: charged.tax - back.tax,
        cgst: charged.cgst - back.cgst, sgst: charged.sgst - back.sgst, igst: charged.igst - back.igst
      }
    };
  });

  const byReason = new Map<string, number>();
  for (const r of returns) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);

  const offersPaise = offered.reduce((n, l) => n + (Array.isArray(l.appliedOffers) ? (l.appliedOffers as any[]).reduce((m, o) => m + (Number(o?.discountPaise) || 0), 0) : 0), 0);

  const base = {
    scope: full ? ('SHOP' as const) : ('MINE_TODAY' as const),
    period: { from: p.from, to: p.to, days: p.days },
    sales: {
      bills,
      grossPaise: totals._sum.subtotalPaise ?? 0,
      discountPaise: totals._sum.discountPaise ?? 0,
      offersPaise,
      taxPaise: totals._sum.taxPaise ?? 0,
      roundOffPaise: totals._sum.roundOffPaise ?? 0,
      netPaise: net,
      averageBillPaise: bills ? Math.round(net / bills) : 0,
      returnsPaise: returnedPaise,
      afterReturnsPaise: net - returnedPaise
    },
    paidIn: payments.map(r => ({ method: r.method, amountPaise: r._sum.amountPaise ?? 0, count: r._count }))
      .sort((a, b) => b.amountPaise - a.amountPaise),
    paidOut: refunds.map(r => ({ method: r.method, amountPaise: r._sum.amountPaise ?? 0 })).sort((a, b) => b.amountPaise - a.amountPaise),
    beingChecked: {
      amountPaise: unsettled.find(r => r.status === 'NEEDS_CHECKING')?._sum.amountPaise ?? 0,
      count: unsettled.find(r => r.status === 'NEEDS_CHECKING')?._count ?? 0
    },
    neverArrived: {
      amountPaise: unsettled.find(r => r.status === 'VOID')?._sum.amountPaise ?? 0,
      count: unsettled.find(r => r.status === 'VOID')?._count ?? 0
    },
    byCashier: byCashier.map(r => ({ name: r.cashierId ? cashierNames.get(r.cashierId) || 'Unknown' : 'Not recorded', bills: r._count, netPaise: r._sum.totalPaise ?? 0 }))
      .sort((a, b) => b.netPaise - a.netPaise),
    byCounter: byCounter.map(r => ({ name: counterNames.get(r.counterId) || 'Unknown', bills: r._count, netPaise: r._sum.totalPaise ?? 0 }))
      .sort((a, b) => b.netPaise - a.netPaise),
    returns: {
      count: returns.length,
      totalPaise: returnedPaise,
      exchanges: returns.filter(r => r.refundMethod === 'EXCHANGE').length,
      reasons: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5)
    },
    discounts: {
      totalPaise: totals._sum.discountPaise ?? 0,
      offersPaise,
      priceOverrides: overrides.length,
      priceOverridesGivenPaise: overrides.reduce((n, l) => n + ((l.listPricePaise ?? 0) - l.unitPricePaise) * l.qty, 0),
      approvals: Object.fromEntries(approvals.map(a => [a.kind, a._count]))
    },
    tax
  };

  if (!full) return base;

  // The rest belongs to whoever runs the shop, not to one till.
  const [shifts, dueOrders, closes, top] = await Promise.all([
    // POS-RPT-008
    prisma.shift.findMany({
      where: { clientId, closedAt: inRange },
      orderBy: { closedAt: 'asc' },
      select: {
        closedAt: true, expectedCashPaise: true, countedCashPaise: true, differencePaise: true, closingNote: true,
        counter: { select: { name: true } }, cashier: { select: { name: true } }
      }
    }),
    // POS-RPT-009. As of now, whatever the period -- a debt does not belong to a date range.
    prisma.sale.findMany({
      where: { clientId, kind: 'KEPT', status: 'BALANCE_DUE' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, invoiceNo: true, createdAt: true, totalPaise: true, promisedAt: true,
        customer: { select: { name: true } },
        payments: { select: { amountPaise: true, status: true } }
      }
    }),
    // POS-RPT-010
    prisma.dayClose.findMany({
      where: { clientId, date: { gte: dayRange(p.from).key, lte: dayRange(p.to).key } },
      orderBy: { date: 'asc' },
      select: { date: true, netPaise: true, returnsPaise: true, variancePaise: true, closedAt: true, closedById: true, openShiftsAtClose: true }
    }),
    // POS-RPT-011 (P1)
    prisma.saleLine.groupBy({
      by: ['itemId'],
      where: { sale: saleWhere, itemId: { not: null } },
      _sum: { qty: true, lineTotalPaise: true },
      orderBy: { _sum: { qty: 'desc' } },
      take: 10
    })
  ]);

  const [closerNames, items] = await Promise.all([
    names(closes.map(c => c.closedById), 'user'),
    prisma.item.findMany({
      where: { id: { in: top.map(t => t.itemId!).filter(Boolean) } },
      select: { id: true, code: true, name: true, colour: true, size: true }
    })
  ]);
  const itemById = new Map(items.map(i => [i.id, i]));

  const dues = dueOrders.map(o => ({
    id: o.id, invoiceNo: o.invoiceNo, customer: o.customer?.name ?? null, createdAt: o.createdAt,
    promisedAt: o.promisedAt, owedPaise: owedPaise(o.totalPaise, o.payments)
  })).filter(o => o.owedPaise > 0);

  return {
    ...base,
    cash: {
      shifts: shifts.map(s => ({
        closedAt: s.closedAt, counter: s.counter.name, cashier: s.cashier?.name ?? null,
        expectedPaise: s.expectedCashPaise, countedPaise: s.countedCashPaise, differencePaise: s.differencePaise, note: s.closingNote
      })),
      totalDifferencePaise: shifts.reduce((n, s) => n + (s.differencePaise ?? 0), 0),
      shortCount: shifts.filter(s => (s.differencePaise ?? 0) < 0).length,
      overCount: shifts.filter(s => (s.differencePaise ?? 0) > 0).length
    },
    dues: {
      count: dues.length,
      totalPaise: dues.reduce((n, d) => n + d.owedPaise, 0),
      oldest: dues.slice(0, 10)
    },
    dayCloses: closes.map(c => ({
      date: c.date.toISOString().slice(0, 10), netPaise: c.netPaise, returnsPaise: c.returnsPaise,
      variancePaise: c.variancePaise, closedAt: c.closedAt, closedBy: c.closedById ? closerNames.get(c.closedById) ?? null : null,
      openShiftsAtClose: c.openShiftsAtClose
    })),
    topProducts: top.map(t => {
      const i = itemById.get(t.itemId!);
      return {
        code: i?.code ?? null,
        name: i ? [i.name, i.colour, i.size].filter(Boolean).join(', ') : 'Unknown item',
        qty: t._sum.qty ?? 0,
        netPaise: t._sum.lineTotalPaise ?? 0
      };
    })
  };
}
