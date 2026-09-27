/**
 * verify-reports -- every figure reconciles to the bills that made it. Phase 9.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:reports
 *
 * The Phase 9 gate is "all P0 reports reconcile to source transactions". So this builds one day of
 * KNOWN activity on a date in the past chosen per run -- two cashiers, two counters, a discount, a
 * price change, a split payment, a return, an exchange, a kept order still owing, a drawer counted
 * Rs 100 short -- and checks each section to the paisa. Then it checks the sections against each
 * other (cashiers add up to the whole, counters add up to the whole, GST lines add up to the bills)
 * and against the day close for the same day, which adds up the same rows a different way.
 *
 * And the limited view: a cashier sees their own bills, today, and nothing else.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale } from '../services/sale';
import { createReturn, createExchange } from '../services/returns';
import { open, close } from '../services/shifts';
import { figures as dayFigures } from '../services/day-close';
import { report } from '../services/reports';
import { findOrCreate } from '../services/customers';
import { __resetLockouts } from '../services/approvals';
import { seed } from './seed-dev';

let passed = 0;
let failed = 0;
const ok = (name: string, condition: boolean, detail = '') => {
  if (condition) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
async function refused(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try { await run(); failed++; console.error(`  FAIL  ${name}\n          it was allowed`); }
  catch (e: any) { ok(name, expect.test(e.message ?? ''), `message: ${e.message}`); }
}

async function actorFor(userId: string): Promise<Actor> {
  const user = await prisma.user.findFirstOrThrow({
    where: { id: userId, clientId: DEV_CLIENT_ID },
    select: { id: true, name: true, roles: { select: { role: { select: { name: true, permissions: { select: { permission: { select: { key: true } } } } } } } } }
  });
  return {
    kind: 'USER', clientId: DEV_CLIENT_ID, id: user.id, name: user.name,
    roles: user.roles.map(r => r.role.name),
    permissions: [...new Set(user.roles.flatMap(r => r.role.permissions.map(p => p.permission.key)))]
  };
}

async function main() {
  console.log('\nverify-reports\n');
  await seed();
  const cashier = await actorFor('dev-cashier');
  const manager = await actorFor('dev-manager');
  const run = randomUUID().slice(0, 6);
  const key = (n: string) => `rpt-${run}-${n}`;

  const counters: string[] = [];
  const counter = async (label: string) => {
    const c = await prisma.counter.create({ data: { clientId: DEV_CLIENT_ID, name: `zz report ${run} ${label}` }, select: { id: true } });
    counters.push(c.id);
    return c.id;
  };
  const item = (code: string) => prisma.item.findFirstOrThrow({ where: { clientId: DEV_CLIENT_ID, code }, select: { id: true } });
  const cotton = await item('COT-010');   // 1,299 at 5%
  const blouse = await item('BLO-101');   //   449 at 5%
  const silk = await item('KAN-001');     // 12,999 at 12% (the seed's rate)
  const silk2 = await item('KAN-002');    // 14,999 at 12%

  // A day of its own in the past.
  const base = new Date(2003, 0, 1);
  base.setDate(base.getDate() + (parseInt(run, 16) % 7000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  const at = (h: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h);

  try {
    const A = await counter('A');
    const B = await counter('B');
    const { customer } = await findOrCreate(manager, { phone: '9' + String(Date.now()).slice(-9), name: 'Report test customer' });
    const shift = (await open(cashier, { counterId: A, openingCashPaise: 50000 })).open!.id;

    // ==========================================================================================
    // The day
    // ==========================================================================================
    __resetLockouts();
    const s1 = await completeSale(cashier, {   // cashier, counter A, 10% off approved by a manager
      onceKey: key('s1'), counterId: A, lines: [{ itemId: cotton.id, qty: 2 }], billDiscountPaise: 51900,
      payments: [{ method: 'CASH', amountPaise: 207900 }], approval: { pin: '2468', reason: 'Festival' }
    });
    const s2 = await completeSale(cashier, {   // cashier, counter A, split cash + UPI
      onceKey: key('s2'), counterId: A, lines: [{ itemId: blouse.id, qty: 1 }, { itemId: cotton.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 48000 }, { method: 'UPI', amountPaise: 126800, reference: 'UPI-RPT' }]
    });
    const s3 = await completeSale(manager, {   // manager, counter B, price override on own authority
      onceKey: key('s3'), counterId: B, lines: [{ itemId: silk.id, qty: 1, overridePricePaise: 1199900 }],
      payments: [{ method: 'CARD', amountPaise: 1199900, reference: 'CARD-RPT' }]
    });
    const s4 = await completeSale(manager, {   // kept order, 500 advance, 799 still owed
      onceKey: key('s4'), counterId: B, kind: 'KEPT', customerId: customer.id,
      lines: [{ itemId: cotton.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 50000 }]
    });
    const s5 = await completeSale(manager, {   // silk, later exchanged for the dearer one
      onceKey: key('s5'), counterId: B, customerId: customer.id,
      lines: [{ itemId: silk.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 1299900 }]
    });
    const r1 = await createReturn(manager, s2.sale.id, {  // the blouse back, in cash
      onceKey: key('r1'), counterId: A, lines: [{ saleLineId: s2.sale.lines.find((l: any) => l.unitPricePaise === 44900)!.id, qty: 1 }],
      reason: 'Wrong size', refund: { method: 'CASH' }
    });
    const ex = await createExchange(manager, s5.sale.id, {
      onceKey: key('ex'), lines: [{ saleLineId: s5.sale.lines[0].id, qty: 1 }], reason: 'Colour',
      newSale: { counterId: B, lines: [{ itemId: silk2.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 200000 }] }
    });
    // Drawer A: float 500 + cash 2,079 + 480 - 449 refund = 2,610 expected; counted 100 short.
    await close(cashier, shift, { countedCashPaise: 251000, note: 'Short by a hundred' });

    // Move all of it onto the chosen day.
    const saleIds = [s1, s2, s3, s4, s5].map(x => x.sale.id).concat(ex.sale!.id);
    const returnIds = [r1.creditNote.id, ex.creditNote.id];
    await prisma.sale.updateMany({ where: { id: { in: saleIds } }, data: { createdAt: at(11) } });
    await prisma.payment.updateMany({ where: { saleId: { in: saleIds } }, data: { createdAt: at(11) } });
    await prisma.return.updateMany({ where: { id: { in: returnIds } }, data: { createdAt: at(15) } });
    await prisma.returnRefund.updateMany({ where: { returnId: { in: returnIds } }, data: { createdAt: at(15) } });
    await prisma.approval.updateMany({ where: { OR: [{ saleId: { in: saleIds } }, { returnId: { in: returnIds } }] }, data: { createdAt: at(11) } });
    await prisma.shift.update({ where: { id: shift }, data: { openedAt: at(9), closedAt: at(20) } });

    const rep: any = await report(manager, { from: date, to: date });
    const allSales = await prisma.sale.findMany({ where: { id: { in: saleIds } } });

    // ==========================================================================================
    console.log('the day, section by section');
    // ==========================================================================================
    eq('POS-RPT-001 bills: six, counting the new bill of the exchange', rep.sales.bills, 6);
    eq('net sales = the six bill totals added up', rep.sales.netPaise, allSales.reduce((n, s) => n + s.totalPaise, 0));
    eq('gross, discount, tax, round-off = the same six, column by column',
      [rep.sales.grossPaise, rep.sales.discountPaise, rep.sales.taxPaise, rep.sales.roundOffPaise],
      ['subtotalPaise', 'discountPaise', 'taxPaise', 'roundOffPaise'].map(k => allSales.reduce((n, s: any) => n + s[k], 0)));
    eq('returns and what is left after them', [rep.sales.returnsPaise, rep.sales.afterReturnsPaise],
      [r1.creditNote.totalPaise + ex.creditNote.totalPaise, rep.sales.netPaise - r1.creditNote.totalPaise - ex.creditNote.totalPaise]);
    eq('average bill', rep.sales.averageBillPaise, Math.round(rep.sales.netPaise / 6));

    const paid = Object.fromEntries(rep.paidIn.map((p: any) => [p.method, p.amountPaise]));
    eq('POS-RPT-002 paid in by method -- the exchange credit shown for what it is, not as money',
      Object.entries(paid).sort(), Object.entries({ CASH: 207900 + 48000 + 50000 + 1299900 + 200000, CARD: 1199900, EXCHANGE: 1299900, UPI: 126800 }).sort());
    eq('given back by method', Object.fromEntries(rep.paidOut.map((p: any) => [p.method, p.amountPaise])), { EXCHANGE: 1299900, CASH: 44900 });

    const cash = rep.byCashier.find((c: any) => c.name === cashier.name);
    const mgr = rep.byCashier.find((c: any) => c.name === manager.name);
    eq('POS-RPT-003 by cashier', [cash?.bills, cash?.netPaise, mgr?.bills], [2, s1.sale.totalPaise + s2.sale.totalPaise, 4]);
    eq('the cashiers add up to the whole day', rep.byCashier.reduce((n: number, c: any) => n + c.netPaise, 0), rep.sales.netPaise);
    const cA = rep.byCounter.find((c: any) => c.name.endsWith(' A'));
    eq('POS-RPT-004 by counter', [cA?.bills, rep.byCounter.length], [2, 2]);
    eq('the counters add up to the whole day', rep.byCounter.reduce((n: number, c: any) => n + c.netPaise, 0), rep.sales.netPaise);

    eq('POS-RPT-005 returns: two, one of them an exchange', [rep.returns.count, rep.returns.exchanges], [2, 1]);
    eq('with their reasons', rep.returns.reasons.map((r: any) => r.reason).sort(), ['Colour', 'Wrong size']);

    eq('POS-RPT-006 discounts given', rep.discounts.totalPaise, allSales.reduce((n, s) => n + s.discountPaise, 0));
    eq('one price change, Rs 1,000 below the tag', [rep.discounts.priceOverrides, rep.discounts.priceOverridesGivenPaise], [1, 100000]);
    eq('the manager approval for the discount is counted', rep.discounts.approvals.DISCOUNT_OVER_LIMIT, 1);

    // GST: every line's tax, per rate, charged minus reversed.
    const lines = await prisma.saleLine.findMany({ where: { saleId: { in: saleIds } } });
    for (const rate of [5, 12]) {
      const r = rep.tax.find((t: any) => t.rate === rate);
      const ls = lines.filter(l => l.taxRate === rate);
      eq(`POS-RPT-007 ${rate}% charged: taxable and tax from the lines`,
        [r?.charged.taxable, r?.charged.tax], [ls.reduce((n, l) => n + l.lineTotalPaise - l.taxPaise, 0), ls.reduce((n, l) => n + l.taxPaise, 0)]);
      ok(`${rate}% CGST + SGST + IGST = tax, charged and reversed`,
        r && r.charged.cgst + r.charged.sgst + r.charged.igst === r.charged.tax && r.reversed.cgst + r.reversed.sgst + r.reversed.igst === r.reversed.tax);
    }
    const back = await prisma.returnLine.findMany({ where: { returnId: { in: returnIds } } });
    eq('GST reversed by the credit notes', rep.tax.reduce((n: number, t: any) => n + t.reversed.tax, 0), back.reduce((n, l) => n + l.taxPaise, 0));
    eq('taxable + tax over every rate + round-off = net sales -- the GST summary IS the bills',
      rep.tax.reduce((n: number, t: any) => n + t.charged.taxable + t.charged.tax, 0) + rep.sales.roundOffPaise, rep.sales.netPaise);

    const sh = rep.cash.shifts.find((x: any) => x.counter.endsWith(' A'));
    eq('POS-RPT-008 the drawer, counted Rs 100 short, as it was recorded', [sh?.expectedPaise, sh?.countedPaise, sh?.differencePaise], [261000, 251000, -10000]);
    ok('with the note', sh?.note === 'Short by a hundred');
    ok('and counted as a short drawer', rep.cash.shortCount >= 1 && rep.cash.totalDifferencePaise <= -10000);

    // Dues are every kept order still owing, as of NOW -- so the whole shop's, not just this day's.
    const owing = await prisma.sale.findMany({ where: { clientId: DEV_CLIENT_ID, kind: 'KEPT', status: 'BALANCE_DUE' }, select: { totalPaise: true, payments: { select: { amountPaise: true, status: true } } } });
    const owed = owing.map(o => o.totalPaise - o.payments.filter(p => p.status !== 'VOID').reduce((n, p) => n + p.amountPaise, 0)).filter(x => x > 0);
    eq('POS-RPT-009 outstanding dues = every kept order still owing, added up', [rep.dues.count, rep.dues.totalPaise], [owed.length, owed.reduce((n, x) => n + x, 0)]);
    ok("including this day's Rs 799", (await prisma.sale.findUniqueOrThrow({ where: { id: s4.sale.id }, select: { status: true } })).status === 'BALANCE_DUE');
    const list = rep.dues.oldest as any[];
    ok('listed oldest first, at most ten', list.length <= 10 && list.every((d, i) => i === 0 || new Date(d.createdAt) >= new Date(list[i - 1].createdAt)));

    // Day close for the same day adds the same rows a different way.
    const day = await dayFigures(manager, date);
    eq('POS-RPT-010 the report and the day close agree: net, returns, paid in, paid out',
      [rep.sales.netPaise, rep.sales.returnsPaise, paid.CASH, paid.UPI], [day.bills.netPaise, day.returns.totalPaise, day.paidIn.CASH, day.paidIn.UPI]);

    const topCodes = rep.topProducts.map((t: any) => t.code);
    ok('POS-RPT-011 top products: cotton leads with four pieces', rep.topProducts[0]?.code === 'COT-010' && rep.topProducts[0]?.qty === 4, JSON.stringify(rep.topProducts[0]));
    ok('every product that sold is there', ['KAN-001', 'KAN-002', 'BLO-101'].every(c => topCodes.includes(c)));

    // ==========================================================================================
    console.log('\nperiods');
    // ==========================================================================================
    const next = new Date(base); next.setDate(next.getDate() + 1);
    const nextDate = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
    const two: any = await report(manager, { from: date, to: nextDate });
    eq('a two-day period containing that day adds the same bills', two.sales.netPaise, rep.sales.netPaise);
    const empty: any = await report(manager, { from: nextDate, to: nextDate });
    eq('the day after: nothing', [empty.sales.bills, empty.sales.netPaise, empty.tax.length], [0, 0, 0]);
    await refused('an end before the start is refused', () => report(manager, { from: nextDate, to: date }), /before the start/);
    await refused('more than 92 days is refused', () => report(manager, { from: '2025-01-01', to: '2025-06-30' }), /92 days or fewer/);
    await refused('a date that does not exist is refused', () => report(manager, { from: '2025-02-30' }), /not a real date/);

    // ==========================================================================================
    console.log('\na cashier sees their own day, and nothing else');
    // ==========================================================================================
    const before: any = await report(cashier, {});
    await completeSale(cashier, { onceKey: key('mine'), counterId: A, lines: [{ itemId: blouse.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 44900 }] });
    await completeSale(manager, { onceKey: key('theirs'), counterId: B, lines: [{ itemId: blouse.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 44900 }] });
    const mineNow: any = await report(cashier, {});
    eq('limited to their own bills', mineNow.scope, 'MINE_TODAY');
    eq('their sale counts, the manager\'s does not', mineNow.sales.bills - before.sales.bills, 1);
    ok('only their own name in by-cashier', mineNow.byCashier.every((c: any) => c.name === cashier.name));
    const asked: any = await report(cashier, { from: date, to: date });
    eq('asking for another day still shows today', asked.period.from, mineNow.period.from);
    ok('no cash, dues, day closes or top products', !('cash' in mineNow) && !('dues' in mineNow) && !('dayCloses' in mineNow) && !('topProducts' in mineNow));
  } finally {
    await prisma.shift.updateMany({ where: { counterId: { in: counters }, closedAt: null }, data: { closedAt: new Date(), closingNote: 'verify-reports cleanup' } });
    await prisma.counter.updateMany({ where: { id: { in: counters } }, data: { active: false } });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
