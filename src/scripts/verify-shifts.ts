/**
 * verify-shifts -- the drawer and the day. Phase 7.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:shifts
 *
 * The question an owner asks at 9 pm is "is the cash right?". This suite is about every way the
 * answer could quietly be wrong:
 *
 *   - change counted as takings (Rs 2,000 handed over for a Rs 1,299 saree)
 *   - a kept order's balance collected into the wrong drawer
 *   - cash out that is not there, or taken by a cashier with nobody's say-so
 *   - a count that is "fixed" to match, or a difference that disappears
 *   - a shift closed while sales are still going through it
 *   - a day closed twice, or changed after it was closed
 *
 * Runs on its own counters, created per run and switched off at the end, so the till's own counter
 * is never touched. The day-close checks run on a date in the past chosen per run, so closing a
 * day here never closes a real one.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale } from '../services/sale';
import { createReturn } from '../services/returns';
import { collect } from '../services/orders';
import { current, open, move, close, openShifts } from '../services/shifts';
import { day, closeDay, dayRange } from '../services/day-close';
import { summary as homeSummary } from '../services/home';
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

async function refused(name: string, run: () => Promise<unknown>, expect: RegExp, code?: string) {
  try {
    await run();
    failed++;
    console.error(`  FAIL  ${name}\n          it was allowed, and should not have been`);
  } catch (error: any) {
    const codeOk = !code || error.details?.code === code;
    ok(name, expect.test(error.message ?? '') && codeOk, `message was: ${error.message}${code ? ` / code ${error.details?.code}` : ''}`);
  }
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
  console.log('\nverify-shifts\n');
  await seed();
  const cashier = await actorFor('dev-cashier');
  const manager = await actorFor('dev-manager');
  const senior = await actorFor('dev-senior');
  const PIN = { pin: '2468', reason: 'Courier paid' };

  const run = randomUUID().slice(0, 6);
  const key = (n: string) => `shf-${run}-${n}`;
  const counters: string[] = [];
  const counter = async (label: string) => {
    const c = await prisma.counter.create({ data: { clientId: DEV_CLIENT_ID, name: `zz test ${run} ${label}` }, select: { id: true } });
    counters.push(c.id);
    return c.id;
  };

  const item = async (code: string) => prisma.item.findFirstOrThrow({ where: { clientId: DEV_CLIENT_ID, code }, select: { id: true } });
  const cotton = await item('COT-010'); // 1,299
  const blouse = await item('BLO-101'); //   449

  try {
    const A = await counter('A');
    const B = await counter('B');

    // ==========================================================================================
    console.log('opening a shift');
    // ==========================================================================================
    await refused('a negative float is refused', () => open(cashier, { counterId: A, openingCashPaise: -100 }), /Enter the cash/);
    const opened = await open(cashier, { counterId: A, openingCashPaise: 100000 });
    ok('a Rs 1,000 float opens the shift', opened.open?.openingCashPaise === 100000);
    eq('opened by the cashier', opened.open?.openedBy, cashier.name);
    await refused('a second shift on the same counter is refused, naming who has it',
      () => open(manager, { counterId: A, openingCashPaise: 0 }), /already has a shift open, by Dev cashier/, 'SHIFT_ALREADY_OPEN');

    const C = await counter('C');
    const race = await Promise.allSettled([1, 2, 3, 4, 5].map(() => open(cashier, { counterId: C, openingCashPaise: 5000 })));
    eq('five people opening one counter at once: one shift', race.filter(r => r.status === 'fulfilled').length, 1);
    ok('the others are told it is already open',
      race.filter(r => r.status === 'rejected').every(r => (r as PromiseRejectedResult).reason?.details?.code === 'SHIFT_ALREADY_OPEN'));
    eq('and the database holds one', await prisma.shift.count({ where: { counterId: C, closedAt: null } }), 1);

    const off = await counter('off');
    await prisma.counter.update({ where: { id: off }, data: { active: false } });
    await refused('a switched-off counter cannot be opened', () => open(cashier, { counterId: off, openingCashPaise: 0 }), /switched off/);

    const cView = await current(cashier, A);
    const mView = await current(manager, A);
    eq('a cashier does not see what the drawer should hold -- the count stays a count', cView.open?.figures, null);
    eq('a manager does', mView.open?.figures?.expectedPaise, 100000);

    // ==========================================================================================
    console.log('\ncash from sales goes into the right drawer');
    // ==========================================================================================
    const shiftA = opened.open!.id;
    const figures = async () => (await current(manager, A)).open!.figures!;

    const s1 = await completeSale(cashier, {
      onceKey: key('s1'), counterId: A, lines: [{ itemId: cotton.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 129900, tenderedPaise: 200000 }]
    });
    eq('the sale knows its shift', (await prisma.sale.findUnique({ where: { id: s1.sale.id } }))?.shiftId, shiftA);
    eq('Rs 2,000 handed over for Rs 1,299: the drawer gains Rs 1,299, not the change', (await figures()).cashSalesPaise, 129900);

    await completeSale(cashier, {
      onceKey: key('s2'), counterId: A, lines: [{ itemId: cotton.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 50000 }, { method: 'UPI', amountPaise: 79900, reference: 'UPI-SPLIT-1' }]
    });
    eq('a split counts only its cash part', (await figures()).cashSalesPaise, 179900);

    const noShift = await completeSale(cashier, {
      onceKey: key('s3'), counterId: B, lines: [{ itemId: blouse.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 44900 }]
    });
    ok('a sale with no shift open still goes through', !!noShift.sale.invoiceNo);
    eq('and belongs to no drawer -- reported, not guessed', (await prisma.payment.findFirst({ where: { saleId: noShift.sale.id } }))?.shiftId, null);

    // A kept order taken elsewhere, its balance collected at counter A.
    const { customer } = await findOrCreate(cashier, { phone: '9' + String(Date.now()).slice(-9), name: 'Shift test customer' });
    const kept = await completeSale(cashier, {
      onceKey: key('kept'), counterId: B, kind: 'KEPT', customerId: customer.id,
      lines: [{ itemId: blouse.id, qty: 1 }], payments: []
    });
    await collect(cashier, kept.sale.id, { onceKey: key('kept-pay'), counterId: A, payments: [{ method: 'CASH', amountPaise: 44900 }] });
    eq("Saturday's balance counts in the drawer it was collected at", (await figures()).cashSalesPaise, 224800);

    // ==========================================================================================
    console.log('\ncash refunds come out of the drawer');
    // ==========================================================================================
    await createReturn(manager, s1.sale.id, {
      onceKey: key('r1'), counterId: A, lines: [{ saleLineId: s1.sale.lines[0].id, qty: 1 }],
      reason: 'Wrong colour', refund: { method: 'CASH' }
    });
    eq('a cash refund comes out of this drawer', (await figures()).cashRefundsPaise, 129900);

    const s4 = await completeSale(cashier, {
      onceKey: key('s4'), counterId: A, lines: [{ itemId: blouse.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 44900 }], customerId: customer.id
    });
    await createReturn(manager, s4.sale.id, {
      onceKey: key('r2'), counterId: A, lines: [{ saleLineId: s4.sale.lines[0].id, qty: 1 }],
      reason: 'Wrong size', refund: { method: 'STORE_CREDIT' }
    });
    eq('a store-credit refund takes nothing out of the drawer', (await figures()).cashRefundsPaise, 129900);

    // ==========================================================================================
    console.log('\ncash in and out');
    // ==========================================================================================
    await refused('cash in needs a reason', () => move(cashier, { counterId: A, direction: 'IN', amountPaise: 50000, reason: '', onceKey: key('in0') }), /Say what the cash was for/);
    await refused('and an amount', () => move(cashier, { counterId: A, direction: 'IN', amountPaise: 0, reason: 'Float', onceKey: key('in0') }), /Enter an amount/);
    await move(cashier, { counterId: A, direction: 'IN', amountPaise: 50000, reason: 'Change float top-up', onceKey: key('in1') });
    await move(cashier, { counterId: A, direction: 'IN', amountPaise: 50000, reason: 'Change float top-up', onceKey: key('in1') });
    eq('Rs 500 in, pressed twice, is recorded once', (await figures()).cashInPaise, 50000);

    await refused('a cashier taking cash out needs a manager',
      () => move(cashier, { counterId: A, direction: 'OUT', amountPaise: 20000, reason: 'Courier', onceKey: key('out1') }),
      /manager needs to approve cash going out/, 'APPROVAL_REQUIRED');
    __resetLockouts();
    await refused("a senior cashier's PIN is not enough",
      () => move(cashier, { counterId: A, direction: 'OUT', amountPaise: 20000, reason: 'Courier', onceKey: key('out1'), approval: { pin: '4455', reason: 'Courier' } }),
      /not allowed to approve taking cash out/, 'NOT_PERMITTED');
    __resetLockouts();
    const out = await move(cashier, { counterId: A, direction: 'OUT', amountPaise: 20000, reason: 'Courier', onceKey: key('out1'), approval: PIN });
    ok('a manager PIN allows it', !out.replayed);
    const outRow = await prisma.cashMovement.findUnique({ where: { onceKey: key('out1') } });
    ok('the movement names who took it and who allowed it', outRow?.byId === cashier.id && outRow?.approvedById === 'dev-manager');
    eq('and says what for, in the list', out.open?.movements.map(m => m.reason), ['Change float top-up', 'Courier']);

    const f1 = await figures();
    // Cash sales so far: 1,299 + 500 (split) + 449 (kept balance) + 449 (s4, later returned to credit).
    const hand = 100000 + (224800 + 44900) - 129900 + 50000 - 20000;
    eq('expected = float + cash sales - cash refunds + in - out, from the rows', f1.expectedPaise, hand);

    await refused('more out than the drawer should hold is refused',
      () => move(manager, { counterId: A, direction: 'OUT', amountPaise: hand + 100, reason: 'Bank deposit', onceKey: key('out2') }),
      /Only ₹2,698 should be in the drawer/, 'MORE_THAN_DRAWER');
    await refused('cash with no shift open has no drawer to go into',
      () => move(manager, { counterId: B, direction: 'IN', amountPaise: 1000, reason: 'Float', onceKey: key('in-b') }),
      /No shift is open on this counter/, 'NO_SHIFT');

    // ==========================================================================================
    console.log('\nclosing: the count is blind and it sticks');
    // ==========================================================================================
    await refused("another cashier cannot close this cashier's shift",
      () => close(senior, shiftA, { countedCashPaise: hand }), /Only Dev cashier or a manager can close this shift/, 'NOT_YOUR_SHIFT');

    await refused("a count that doesn't match is refused WITHOUT saying the expected figure",
      () => close(cashier, shiftA, { countedCashPaise: hand - 10000 }),
      /^That count doesn't match what the till expects\. Count again/, 'COUNT_MISMATCH');
    const attempt = await prisma.auditLog.findFirst({ where: { action: 'shift.count_mismatch', detail: { path: ['shiftId'], equals: shiftA } } });
    eq('the mismatched count is in the audit trail with both figures',
      [(attempt?.detail as any)?.countedPaise, (attempt?.detail as any)?.expectedPaise], [hand - 10000, hand]);
    eq('and the shift is still open', (await current(cashier, A)).open?.id, shiftA);

    const closed = await close(cashier, shiftA, { countedCashPaise: hand - 10000, note: 'Gave Rs 100 too much change, I think' });
    eq('with a note it closes, Rs 100 short, recorded as it is', closed.differencePaise, -10000);
    const row = await prisma.shift.findUniqueOrThrow({ where: { id: shiftA } });
    eq('the close is stored: expected, counted, difference, note, who',
      [row.expectedCashPaise, row.countedCashPaise, row.differencePaise, row.closingNote, row.closedById],
      [hand, hand - 10000, -10000, 'Gave Rs 100 too much change, I think', cashier.id]);
    await refused('a closed shift is never changed', () => close(manager, shiftA, { countedCashPaise: hand }), /already closed/, 'ALREADY_CLOSED');
    await refused('and takes no more cash', () => move(manager, { counterId: A, direction: 'IN', amountPaise: 100, reason: 'Late float', onceKey: key('late-in') }), /No shift is open/);
    const after = await completeSale(cashier, { onceKey: key('after'), counterId: A, lines: [{ itemId: blouse.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 44900 }] });
    eq('a sale after the close belongs to no drawer', (await prisma.sale.findUnique({ where: { id: after.sale.id } }))?.shiftId, null);
    const recent = (await current(cashier, A)).recent[0];
    eq('the closed shift shows its difference to everyone', [recent.differencePaise, recent.closingNote !== null], [-10000, true]);
    eq('and its count becomes the suggested float for next time', (await current(cashier, A)).suggestedOpeningPaise, hand - 10000);

    const exact = await open(cashier, { counterId: A, openingCashPaise: 30000 });
    const fine = await close(cashier, exact.open!.id, { countedCashPaise: 30000 });
    eq('a count that matches closes with no note needed', fine.differencePaise, 0);

    const other = await open(cashier, { counterId: A, openingCashPaise: 0 });
    const byManager = await close(manager, other.open!.id, { countedCashPaise: 0 });
    eq("a manager may close a cashier's shift", byManager.differencePaise, 0);

    // ==========================================================================================
    console.log('\nclosing while sales are still going through');
    // ==========================================================================================
    const R = await counter('race');
    const raceShift = (await open(cashier, { counterId: R, openingCashPaise: 0 })).open!.id;
    const inFlight = [1, 2, 3, 4, 5, 6].map(i => completeSale(cashier, {
      onceKey: key(`race-${i}`), counterId: R, lines: [{ itemId: blouse.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 44900 }]
    }));
    await new Promise(r => setTimeout(r, 15));
    const closing = close(manager, raceShift, { countedCashPaise: 0, note: 'Closing during the race test' });
    await Promise.allSettled([...inFlight, closing]);
    const rs = await prisma.shift.findUniqueOrThrow({ where: { id: raceShift } });
    const counted = await prisma.payment.aggregate({ where: { shiftId: raceShift, method: 'CASH' }, _sum: { amountPaise: true } });
    eq('the close counted exactly the cash that went into the drawer -- none slipped in after',
      rs.expectedCashPaise, counted._sum.amountPaise ?? 0);
    const allSix = await prisma.sale.count({ where: { onceKey: { startsWith: key('race-') } } });
    eq('and every sale still went through', allSix, 6);

    // ==========================================================================================
    console.log('\na shift left open overnight');
    // ==========================================================================================
    const N = await counter('night');
    const night = (await open(cashier, { counterId: N, openingCashPaise: 0 })).open!.id;
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(20, 0, 0, 0);
    await prisma.shift.update({ where: { id: night }, data: { openedAt: yesterday } });
    ok('it is flagged', (await openShifts(DEV_CLIENT_ID)).find(s => s.id === night)?.openSinceYesterday === true);
    ok('on Home as well', (await homeSummary(manager)).shifts.overnight >= 1);
    eq('and on its counter', (await current(cashier, N)).open?.openSinceYesterday, true);
    await close(cashier, night, { countedCashPaise: 0 });

    // ==========================================================================================
    console.log('\nthe day close');
    // ==========================================================================================
    // A day in the past of its own, so closing it never closes a real one.
    const base = new Date(2001, 0, 1);
    base.setDate(base.getDate() + (parseInt(run, 16) % 8000));
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
    const at = (h: number, m = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m);

    const D = await counter('day');
    const D2 = await counter('day2');
    const dShift = (await open(cashier, { counterId: D, openingCashPaise: 100000 })).open!.id;
    const d1 = await completeSale(cashier, { onceKey: key('d1'), counterId: D, lines: [{ itemId: cotton.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 129900 }] });
    const d2 = await completeSale(cashier, { onceKey: key('d2'), counterId: D, lines: [{ itemId: blouse.id, qty: 1 }], payments: [{ method: 'UPI', amountPaise: 44900, reference: 'UPI-D2' }] });
    const d3 = await completeSale(cashier, { onceKey: key('d3'), counterId: D, lines: [{ itemId: cotton.id, qty: 1 }], payments: [{ method: 'UPI', amountPaise: 129900, unconfirmed: true }] });
    const d4 = await completeSale(cashier, { onceKey: key('d4'), counterId: D2, lines: [{ itemId: blouse.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 44900 }] });
    const dr = await createReturn(manager, d1.sale.id, {
      onceKey: key('dr'), counterId: D, lines: [{ saleLineId: d1.sale.lines[0].id, qty: 1 }], reason: 'Damaged', refund: { method: 'CASH' }
    });
    await move(cashier, { counterId: D, direction: 'IN', amountPaise: 50000, reason: 'Float', onceKey: key('d-in') });
    await move(manager, { counterId: D, direction: 'OUT', amountPaise: 20000, reason: 'Tea and snacks', onceKey: key('d-out') });
    const dExpected = 100000 + 129900 - 129900 + 50000 - 20000;
    await close(cashier, dShift, { countedCashPaise: dExpected - 10000, note: 'Short, looking into it' });

    // Move all of it onto the chosen day.
    const saleIds = [d1, d2, d3, d4].map(s => s.sale.id);
    await prisma.sale.updateMany({ where: { id: { in: saleIds } }, data: { createdAt: at(11) } });
    await prisma.payment.updateMany({ where: { saleId: { in: saleIds } }, data: { createdAt: at(11) } });
    await prisma.return.update({ where: { id: dr.creditNote.id }, data: { createdAt: at(15) } });
    await prisma.returnRefund.updateMany({ where: { returnId: dr.creditNote.id }, data: { createdAt: at(15) } });
    await prisma.cashMovement.updateMany({ where: { shiftId: dShift }, data: { createdAt: at(16) } });
    await prisma.shift.update({ where: { id: dShift }, data: { openedAt: at(9), closedAt: at(21) } });

    const live = (await day(manager, date)).live;
    eq('bills that day, including the returned one', live.bills.count, 4);
    eq('net sales', live.bills.netPaise, 129900 + 44900 + 129900 + 44900);
    eq('returns on their own line', [live.returns.count, live.returns.totalPaise], [1, 129900]);
    eq('money in by method -- the UPI still being checked is not counted as in', live.paidIn, { CASH: 174800, UPI: 44900 });
    eq('money out by method', live.paidOut, { CASH: 129900 });
    eq('the drawers should hold float + cash - refunds + in - out', live.cash.positionPaise, 100000 + 174800 - 129900 + 50000 - 20000);
    eq('cash taken with no shift open is shown on its own', live.cash.unattributedPaise, 44900);
    eq('counted, and the difference, from the shift closed that day', [live.cash.countedPaise, live.cash.variancePaise], [dExpected - 10000, -10000]);
    eq('the UPI still to check is called out', live.paymentsToCheck, 1);
    eq('nothing waiting to sync', live.pendingSync, 0);

    await refused('a cashier cannot close the day', () => closeDay(cashier, date), /Only a manager or the owner/, 'NOT_PERMITTED');

    const lateShift = (await open(cashier, { counterId: D2, openingCashPaise: 0 })).open!.id;
    await prisma.shift.update({ where: { id: lateShift }, data: { openedAt: at(18) } });
    await refused('a shift still open stops the close, and is named',
      () => closeDay(manager, date), /A shift is still open: zz test .* day2 \(Dev cashier\)/, 'OPEN_SHIFTS');
    const done = await closeDay(manager, date, { acceptOpenShifts: true, note: 'Counter 2 left open by mistake' });
    ok('closing anyway, said out loud, works', !!done.closed);
    eq('and the close remembers a shift was left open', done.closed?.openShiftsAtClose, 1);
    eq('it names who closed it', done.closed?.closedBy, manager.name);
    await close(cashier, lateShift, { countedCashPaise: 0 });

    const stored = await prisma.dayClose.findFirstOrThrow({ where: { clientId: DEV_CLIENT_ID, date: dayRange(date).key } });
    eq('stored under its own calendar date, not the day before', stored.date.toISOString().slice(0, 10), date);

    await refused('a day cannot be closed twice', () => closeDay(manager, date), /already closed by Meena/, 'ALREADY_CLOSED');

    // A sale that lands on the closed day afterwards: the closed figures do not move.
    const late = await completeSale(cashier, { onceKey: key('late'), counterId: D2, lines: [{ itemId: blouse.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 44900 }] });
    await prisma.sale.update({ where: { id: late.sale.id }, data: { createdAt: at(22) } });
    const reread = await day(manager, date);
    eq('the closed day keeps its numbers', reread.closed?.figures.bills.netPaise, 349600);
    eq('and shows what came after on its own line', [reread.closed?.since?.bills, reread.closed?.since?.netPaise], [1, 44900]);

    const empty = new Date(base); empty.setDate(empty.getDate() + 1);
    const emptyDate = `${empty.getFullYear()}-${pad(empty.getMonth() + 1)}-${pad(empty.getDate())}`;
    const twice = await Promise.allSettled([1, 2, 3].map(() => closeDay(manager, emptyDate)));
    eq('three managers closing one day at once: one close', twice.filter(r => r.status === 'fulfilled').length, 1);

    await refused('a day in the future cannot be closed', () => closeDay(manager, '2999-01-01'), /has not happened yet/);
    await refused('a date that does not exist is refused', () => day(manager, '2026-02-30'), /not a real date/);
  } finally {
    // Leave nothing open and nothing on the till's counter list.
    await prisma.shift.updateMany({ where: { counterId: { in: counters }, closedAt: null }, data: { closedAt: new Date(), closingNote: 'verify-shifts cleanup' } });
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
