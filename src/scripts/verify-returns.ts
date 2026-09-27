/**
 * verify-returns -- returns, credit notes, refunds, store credit and exchanges. Phase 6.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:returns
 *
 * Clothing lives on exchanges. The situations this exists for:
 *
 *   - a saree bought at a discount comes back -- at the price she paid, not the tag
 *   - three pieces return one at a time, and the refunds add to exactly what was paid
 *   - two cashiers take the same saree back at the same moment
 *   - the same store credit is spent at two tills at once
 *   - a return a week late, asked for by a cashier
 *   - an exchange for something dearer, cheaper, and the same price
 *   - credit paid in store credit trying to come back as cash
 *
 * Every refusal is checked for its MESSAGE as well as the fact of refusing, because "cannot return"
 * with no reason is what makes a cashier give up and hand over cash from their own pocket.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale, getSale } from '../services/sale';
import {
  eligibility, quote, createReturn, createExchange, getReturn, shareOf, windowFor, approvalNeeded
} from '../services/returns';
import { collect, list as listOrders, markReady } from '../services/orders';
import { resolve } from '../services/payments';
import { findOrCreate, detail as customerDetail } from '../services/customers';
import { summary as homeSummary } from '../services/home';
import { __resetLockouts } from '../services/approvals';
import { seed } from './seed-dev';

let passed = 0;
let failed = 0;

const ok = (name: string, condition: boolean, detail = '') => {
  if (condition) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};

const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

async function refused(name: string, run: () => Promise<unknown>, expect: RegExp, code?: string) {
  try {
    await run();
    failed++;
    console.error(`  FAIL  ${name}\n          it was allowed, and should not have been`);
  } catch (error: any) {
    const codeOk = !code || error.details?.code === code;
    ok(name, expect.test(error.message ?? '') && codeOk,
      `message was: ${error.message}${code ? ` / code ${error.details?.code}` : ''}`);
  }
}

async function actorFor(userId: string): Promise<Actor> {
  const user = await prisma.user.findFirstOrThrow({
    where: { id: userId, clientId: DEV_CLIENT_ID },
    select: {
      id: true, name: true,
      roles: { select: { role: { select: { name: true, permissions: { select: { permission: { select: { key: true } } } } } } } }
    }
  });
  return {
    kind: 'USER', clientId: DEV_CLIENT_ID, id: user.id, name: user.name,
    roles: user.roles.map(r => r.role.name),
    permissions: [...new Set(user.roles.flatMap(r => r.role.permissions.map(p => p.permission.key)))]
  };
}

const seqOf = (no: string) => Number(no.split('/').pop());

async function main() {
  console.log('\nverify-returns\n');
  const { counterId } = await seed();
  const cashier = await actorFor('dev-cashier');
  const manager = await actorFor('dev-manager');
  const senior = await actorFor('dev-senior');
  const PIN = { pin: '2468', reason: 'Customer is a regular' };

  const item = async (code: string) => prisma.item.findFirstOrThrow({
    where: { clientId: DEV_CLIENT_ID, code }, select: { id: true, pricePaise: true }
  });
  const cotton = await item('COT-010');    // 1,299.00 at 5%
  const blouse = await item('BLO-101');    //   449.00
  const blouse2 = await item('BLO-102');   //   449.00
  const silk = await item('KAN-001');      // 12,999.00
  const silk2 = await item('KAN-002');     // 14,999.00

  const run = randomUUID().slice(0, 8);
  const key = (n: string) => `ret-${run}-${n}`;
  const phone = () => '9' + String(Date.now() + Math.floor(Math.random() * 1000)).slice(-9);

  const { customer: priya } = await findOrCreate(cashier, { phone: phone(), name: 'Priya (returns test)' });

  const sell = (name: string, lines: any[], payments: any[], extra: any = {}, who: Actor = cashier) =>
    completeSale(who, { onceKey: key(name), counterId, lines, payments, ...extra });

  const cash = (amountPaise: number) => ({ method: 'CASH' as const, amountPaise });

  // ==========================================================================================
  console.log('the arithmetic');
  // ==========================================================================================
  const orders = [[1, 1, 1], [2, 1], [1, 2], [3]];
  for (const order of orders) {
    let from = 0;
    let sum = 0;
    for (const n of order) { sum += shareOf(10000, 3, from, from + n); from += n; }
    eq(`Rs 100 over 3 pieces, returned as ${order.join('+')}, refunds exactly Rs 100`, sum, 10000);
  }
  eq('one piece of three at Rs 100 is 33.33', shareOf(10000, 3, 0, 1), 3333);

  let sweepBad = 0;
  for (let total = 0; total <= 60000; total += 97) {
    for (let qty = 1; qty <= 7; qty++) {
      let from = 0;
      let sum = 0;
      while (from < qty) {
        const step = 1 + ((total + from) % (qty - from));
        const to = Math.min(qty, from + step);
        const part = shareOf(total, qty, from, to);
        if (part < 0) sweepBad++;
        sum += part;
        from = to;
      }
      if (sum !== total) sweepBad++;
    }
  }
  eq('4,300 lines returned in uneven pieces all add back to the line, never a negative part', sweepBad, 0);

  const now = new Date(2026, 8, 27, 10, 0);
  eq('sold today is inside the window', windowFor(new Date(2026, 8, 27, 9, 0), 7, now).outside, false);
  eq('sold 7 days ago is still inside -- the last day counts', windowFor(new Date(2026, 8, 20, 19, 0), 7, now).outside, false);
  eq('sold 8 days ago is outside', windowFor(new Date(2026, 8, 19, 9, 0), 7, now).outside, true);
  eq('late last night is one day ago, not zero', windowFor(new Date(2026, 8, 26, 23, 59), 7, now).daysSince, 1);

  const inside = windowFor(new Date(), 7);
  const late = windowFor(new Date(Date.now() - 12 * 86_400_000), 7);
  eq('a cashier needs a manager for any return', approvalNeeded(cashier, inside), 'RETURN');
  eq('a manager does not', approvalNeeded(manager, inside), null);
  eq('a cashier returning late needs the late-return approval', approvalNeeded(cashier, late), 'RETURN_OUTSIDE_WINDOW');
  eq('a manager may take a late return on their own authority', approvalNeeded(manager, late), null);
  eq('a senior cashier with a PIN is still a cashier', approvalNeeded(senior, inside), 'RETURN');

  // ==========================================================================================
  console.log('\nwhat can come back');
  // ==========================================================================================
  const s1 = await sell('s1', [{ itemId: cotton.id, qty: 3 }, { itemId: blouse.id, qty: 1 }],
    [cash(3 * 129900 + 44900)], { customerId: priya.id });
  const cot = s1.sale.lines.find((l: any) => l.qty === 3)!;
  const blo = s1.sale.lines.find((l: any) => l.qty === 1)!;

  const e1 = await eligibility(cashier, s1.sale.id);
  eq('a fresh bill is open for returns', e1.blocked, null);
  eq('every piece can come back', e1.lines.map(l => l.remainingQty).sort(), [1, 3]);
  eq('this cashier will need a manager', e1.approvalNeeded, 'RETURN');
  eq('all of it was paid in money, so all of it can go back as money', e1.moneyRefundablePaise, s1.sale.totalPaise);
  ok('the customer is shown, masked', e1.customer?.phoneMasked?.startsWith('••••') === true);
  eq('store credit is always offered', e1.refundMethods.includes('STORE_CREDIT'), true);

  const q1 = await quote(cashier, s1.sale.id, [{ saleLineId: cot.id, qty: 1 }]);
  eq('one cotton saree quotes at what was paid for it', q1.totalPaise, 129900);
  eq('its tax is the line tax, split the same way', q1.lines[0].cgstPaise + q1.lines[0].sgstPaise, q1.taxPaise);
  eq('not the last piece, so no round-off comes back', q1.roundOffPaise, 0);

  // ==========================================================================================
  console.log('\na cashier returning one saree');
  // ==========================================================================================
  const cnBefore = await prisma.invoiceSeries.findFirst({
    where: { clientId: DEV_CLIENT_ID, kind: 'CREDIT_NOTE' }, select: { lastNumber: true }
  });

  await refused('without a manager, it is refused and says why',
    () => createReturn(cashier, s1.sale.id, {
      onceKey: key('r1'), lines: [{ saleLineId: cot.id, qty: 1 }], reason: 'Wrong colour',
      refund: { method: 'CASH' }
    }),
    /manager needs to approve this return/, 'APPROVAL_REQUIRED');

  __resetLockouts();
  await refused('a wrong PIN is refused',
    () => createReturn(cashier, s1.sale.id, {
      onceKey: key('r1'), lines: [{ saleLineId: cot.id, qty: 1 }], reason: 'Wrong colour',
      refund: { method: 'CASH' }, approval: { pin: '0000', reason: 'Regular customer' }
    }),
    /not recognised/, 'PIN_NOT_RECOGNISED');

  await refused("a senior cashier's PIN cannot approve a refund",
    () => createReturn(cashier, s1.sale.id, {
      onceKey: key('r1'), lines: [{ saleLineId: cot.id, qty: 1 }], reason: 'Wrong colour',
      refund: { method: 'CASH' }, approval: { pin: '4455', reason: 'Regular customer' }
    }),
    /not allowed to approve a refund/, 'NOT_PERMITTED');
  __resetLockouts();

  const r1 = await createReturn(cashier, s1.sale.id, {
    onceKey: key('r1'), lines: [{ saleLineId: cot.id, qty: 1 }], reason: 'Wrong colour',
    refund: { method: 'CASH' }, approval: PIN
  });
  ok('with a manager PIN it goes through', !r1.replayed);
  ok('as a credit note in its own series', /^CN\/\d{4}-\d{2}\/\d{4}$/.test(r1.creditNote.creditNoteNo), r1.creditNote.creditNoteNo);
  eq('the refused attempts did not use up a number', seqOf(r1.creditNote.creditNoteNo), (cnBefore?.lastNumber ?? 0) + 1);
  eq('refunding Rs 1,299 in cash', r1.creditNote.refunds, [{ method: 'CASH', amountPaise: 129900, reference: null }]);
  ok('a manager is named on it', typeof r1.creditNote.approvedBy === 'string' && r1.creditNote.approvedBy.length > 0);
  eq('and the reason it came back', r1.creditNote.reason, 'Wrong colour');

  const appr = await prisma.approval.findFirst({ where: { returnId: r1.creditNote.id } });
  eq('the approval points at the return it allowed', appr?.kind, 'RETURN');

  const audit = await prisma.auditLog.findMany({
    where: { clientId: DEV_CLIENT_ID, subject: r1.creditNote.creditNoteNo }, select: { action: true }
  });
  eq('the audit trail has the return and the approval', audit.map(a => a.action).sort(), ['approval.granted', 'return.created']);

  const again = await createReturn(cashier, s1.sale.id, {
    onceKey: key('r1'), lines: [{ saleLineId: cot.id, qty: 1 }], reason: 'Wrong colour',
    refund: { method: 'CASH' }, approval: PIN
  });
  ok('pressing it twice gives the same credit note back', again.replayed && again.creditNote.id === r1.creditNote.id);
  eq('and refunds once', await prisma.return.count({ where: { originalSaleId: s1.sale.id } }), 1);

  await refused('the same key for a different return is refused, naming the credit note',
    () => createReturn(cashier, s1.sale.id, {
      onceKey: key('r1'), lines: [{ saleLineId: cot.id, qty: 2 }], reason: 'Wrong colour',
      refund: { method: 'CASH' }, approval: PIN
    }),
    new RegExp(`already recorded as ${r1.creditNote.creditNoteNo.replace(/\//g, '.')}`), 'RETURN_ALREADY_RECORDED');

  const bill1 = await getSale(cashier, s1.sale.id);
  eq('the bill shows one of three cotton sarees returned', bill1.lines.find((l: any) => l.id === cot.id)?.returnedQty, 1);
  eq('and lists the credit note', bill1.returns.map((r: any) => r.creditNoteNo), [r1.creditNote.creditNoteNo]);
  eq('a part-returned bill stays COMPLETED', bill1.status, 'COMPLETED');

  // ==========================================================================================
  console.log('\ntwo cashiers, the same two sarees, the same moment');
  // ==========================================================================================
  const race = await Promise.allSettled([
    createReturn(manager, s1.sale.id, { onceKey: key('race-a'), lines: [{ saleLineId: cot.id, qty: 2 }], reason: 'Damaged', refund: { method: 'CASH' } }),
    createReturn(manager, s1.sale.id, { onceKey: key('race-b'), lines: [{ saleLineId: cot.id, qty: 2 }], reason: 'Damaged', refund: { method: 'CASH' } })
  ]);
  eq('exactly one of them is recorded', race.filter(r => r.status === 'fulfilled').length, 1);
  const loser = race.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  ok('the other is told it has already come back', /already been returned/.test(loser?.reason?.message ?? ''), loser?.reason?.message);

  await refused('a line not on this bill is refused',
    () => createReturn(manager, s1.sale.id, { onceKey: key('x1'), lines: [{ saleLineId: randomUUID(), qty: 1 }], reason: 'Damaged', refund: { method: 'CASH' } }),
    /not on this bill/, 'NOT_ON_BILL');
  await refused('the same line twice is refused',
    () => createReturn(manager, s1.sale.id, {
      onceKey: key('x2'), lines: [{ saleLineId: blo.id, qty: 1 }, { saleLineId: blo.id, qty: 1 }], reason: 'Damaged', refund: { method: 'CASH' }
    }),
    /listed twice/);

  const last = await createReturn(manager, s1.sale.id, {
    onceKey: key('last'), lines: [{ saleLineId: blo.id, qty: 1 }], reason: 'Does not fit', refund: { method: 'CASH' }
  });
  eq('a manager needs no PIN', last.creditNote.approvedBy, null);
  const all = await prisma.return.aggregate({ where: { originalSaleId: s1.sale.id }, _sum: { totalPaise: true } });
  eq('every credit note for the bill adds to exactly what was paid', all._sum.totalPaise, s1.sale.totalPaise);
  eq('the bill is now RETURNED', (await getSale(cashier, s1.sale.id)).status, 'RETURNED');
  eq('and says so before anyone tries', (await eligibility(cashier, s1.sale.id)).blocked?.code, 'ALL_RETURNED');
  await refused('nothing more can come back',
    () => createReturn(manager, s1.sale.id, { onceKey: key('x3'), lines: [{ saleLineId: blo.id, qty: 1 }], reason: 'Damaged', refund: { method: 'CASH' } }),
    /already been returned/, 'ALL_RETURNED');

  // ==========================================================================================
  console.log('\nbought at a discount, back at the discount');
  // ==========================================================================================
  const s2 = await sell('s2', [{ itemId: cotton.id, qty: 3 }], [cash(386400)], { billDiscountPaise: 3333 }, manager);
  eq('Rs 33.33 off three sarees rounds the bill to Rs 3,864', s2.sale.totalPaise, 386400);
  const round = s2.sale.roundOffPaise;
  ok('with a round-off to give back at the end', round !== 0, `roundOff ${round}`);
  const line2 = s2.sale.lines[0];
  const parts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await createReturn(manager, s2.sale.id, {
      onceKey: key(`disc-${i}`), lines: [{ saleLineId: line2.id, qty: 1 }], reason: 'Changed mind', refund: { method: 'CASH' }
    });
    parts.push(r.creditNote.totalPaise);
    if (i < 2) eq(`piece ${i + 1} carries no round-off`, r.creditNote.roundOffPaise, 0);
    else eq('the last piece carries the round-off', r.creditNote.roundOffPaise, round);
  }
  ok('each piece came back below the tag price', parts.every(p => p < 129900), JSON.stringify(parts));
  eq('three refunds add to exactly the Rs 3,864 paid', parts.reduce((a, b) => a + b, 0), 386400);

  // ==========================================================================================
  console.log('\nhow the money goes back');
  // ==========================================================================================
  const s3 = await sell('s3', [{ itemId: cotton.id, qty: 4 }], [cash(4 * 129900)], {}, manager);
  const l3 = s3.sale.lines[0];

  await refused('a UPI refund needs its reference',
    () => createReturn(manager, s3.sale.id, { onceKey: key('upi'), lines: [{ saleLineId: l3.id, qty: 1 }], reason: 'Damaged', refund: { method: 'UPI' } }),
    /UPI refund reference/, 'REFERENCE_REQUIRED');
  const upi = await createReturn(manager, s3.sale.id, {
    onceKey: key('upi'), lines: [{ saleLineId: l3.id, qty: 1 }], reason: 'Damaged', refund: { method: 'UPI', reference: 'UPI-REF-771' }
  });
  eq('with one, it is recorded', upi.creditNote.refunds[0].reference, 'UPI-REF-771');

  const saved = await prisma.shopSettings.findUniqueOrThrow({ where: { clientId: DEV_CLIENT_ID }, select: { enabledPaymentMethods: true } });
  await prisma.shopSettings.update({ where: { clientId: DEV_CLIENT_ID }, data: { enabledPaymentMethods: ['CASH', 'UPI'] } });
  await refused('a shop that has turned card off cannot refund to a card',
    () => createReturn(manager, s3.sale.id, { onceKey: key('card'), lines: [{ saleLineId: l3.id, qty: 1 }], reason: 'Damaged', refund: { method: 'CARD', reference: 'X' } }),
    /not set up to give refunds by card/);
  eq('and the screen does not offer it', (await eligibility(manager, s3.sale.id)).refundMethods, ['CASH', 'UPI', 'STORE_CREDIT']);
  await prisma.shopSettings.update({ where: { clientId: DEV_CLIENT_ID }, data: { enabledPaymentMethods: saved.enabledPaymentMethods } });

  await refused('store credit needs somebody to hold it',
    () => createReturn(manager, s3.sale.id, { onceKey: key('sc0'), lines: [{ saleLineId: l3.id, qty: 1 }], reason: 'Damaged', refund: { method: 'STORE_CREDIT' } }),
    /kept against a phone number/, 'CUSTOMER_REQUIRED');

  const { customer: walkIn } = await findOrCreate(cashier, { phone: phone(), name: 'Walk-in gives a number now' });
  const credit1 = await createReturn(manager, s3.sale.id, {
    onceKey: key('sc1'), lines: [{ saleLineId: l3.id, qty: 1 }], reason: 'Damaged', refund: { method: 'STORE_CREDIT' }, customerId: walkIn.id
  });
  eq('a cash buyer who gave no number can give one now and take credit', credit1.creditNote.customer?.storeCreditPaise, 129900);
  const ledger = await prisma.storeCreditEntry.findMany({ where: { customerId: walkIn.id } });
  eq('the ledger says why', ledger.map(e => [e.amountPaise, e.balanceAfterPaise, e.returnId]), [[129900, 129900, credit1.creditNote.id]]);

  const onPriya = await sell('s4', [{ itemId: cotton.id, qty: 1 }], [cash(129900)], { customerId: priya.id }, manager);
  await refused("credit for Priya's bill cannot go to somebody else",
    () => createReturn(manager, onPriya.sale.id, {
      onceKey: key('sc2'), lines: [{ saleLineId: onPriya.sale.lines[0].id, qty: 1 }], reason: 'Damaged', refund: { method: 'STORE_CREDIT' }, customerId: walkIn.id
    }),
    /already belongs to a customer/, 'DIFFERENT_CUSTOMER');

  // ==========================================================================================
  console.log('\nspending store credit');
  // ==========================================================================================
  await refused('store credit on a bill with no customer is refused',
    () => sell('sp0', [{ itemId: blouse.id, qty: 1 }], [{ method: 'CREDIT', amountPaise: 44900 }]),
    /belongs to a customer/, 'CUSTOMER_REQUIRED');

  const invBefore = await prisma.invoiceSeries.findFirst({ where: { clientId: DEV_CLIENT_ID, kind: 'INVOICE' }, select: { lastNumber: true } });
  await refused('more than the balance is refused with the real balance',
    () => sell('sp1', [{ itemId: silk.id, qty: 1 }], [{ method: 'CREDIT', amountPaise: 1299900 }], { customerId: walkIn.id }),
    /only ₹1,299 of store credit/, 'NOT_ENOUGH_CREDIT');
  const invAfter = await prisma.invoiceSeries.findFirst({ where: { clientId: DEV_CLIENT_ID, kind: 'INVOICE' }, select: { lastNumber: true } });
  eq('and the refused sale took no invoice number', invAfter?.lastNumber, invBefore?.lastNumber);

  await refused('store credit cannot be left "to check"',
    () => sell('sp2', [{ itemId: blouse.id, qty: 1 }], [{ method: 'CREDIT', amountPaise: 44900, unconfirmed: true }], { customerId: walkIn.id }),
    /either there or it is not/);

  // Two tills, the same Rs 1,299, the same moment.
  const spendRace = await Promise.allSettled([
    sell('spA', [{ itemId: cotton.id, qty: 1 }], [{ method: 'CREDIT', amountPaise: 129900 }], { customerId: walkIn.id }),
    sell('spB', [{ itemId: cotton.id, qty: 1 }], [{ method: 'CREDIT', amountPaise: 129900 }], { customerId: walkIn.id })
  ]);
  eq('the same credit spent at two tills at once: one sale', spendRace.filter(r => r.status === 'fulfilled').length, 1);
  const spendLoser = spendRace.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  ok('the other is told there is none left', /no store credit left/.test(spendLoser?.reason?.message ?? ''), spendLoser?.reason?.message);
  const wBal = await prisma.customer.findUniqueOrThrow({ where: { id: walkIn.id }, select: { storeCreditPaise: true } });
  eq('the balance is zero, not minus Rs 1,299', wBal.storeCreditPaise, 0);

  let constraint = false;
  try {
    await prisma.$executeRaw`UPDATE customers SET store_credit_paise = -1 WHERE id = ${walkIn.id}`;
  } catch { constraint = true; }
  ok('the database itself refuses a negative balance', constraint);

  // ==========================================================================================
  console.log('\ncredit that was spent comes back as credit');
  // ==========================================================================================
  const { customer: asha } = await findOrCreate(cashier, { phone: phone(), name: 'Asha (credit test)' });
  const giveAsha = await sell('asha0', [{ itemId: cotton.id, qty: 1 }], [cash(129900)], { customerId: asha.id }, manager);
  await createReturn(manager, giveAsha.sale.id, {
    onceKey: key('asha-cr'), lines: [{ saleLineId: giveAsha.sale.lines[0].id, qty: 1 }], reason: 'Changed mind', refund: { method: 'STORE_CREDIT' }
  });
  const split = await sell('asha1', [{ itemId: cotton.id, qty: 1 }, { itemId: blouse.id, qty: 1 }],
    [{ method: 'CREDIT', amountPaise: 129900 }, cash(44900)], { customerId: asha.id });
  eq('a bill paid Rs 1,299 in credit and Rs 449 in cash', split.sale.payments.map((p: any) => p.method).sort(), ['CASH', 'CREDIT']);
  eq('only the Rs 449 can go back as money', (await eligibility(manager, split.sale.id)).moneyRefundablePaise, 44900);

  const cnMid = await prisma.invoiceSeries.findFirst({ where: { clientId: DEV_CLIENT_ID, kind: 'CREDIT_NOTE' }, select: { lastNumber: true } });
  const splitCot = split.sale.lines.find((l: any) => l.unitPricePaise === 129900)!;
  await refused('the saree bought with credit cannot come back as cash',
    () => createReturn(manager, split.sale.id, {
      onceKey: key('asha-cash'), lines: [{ saleLineId: splitCot.id, qty: 1 }], reason: 'Changed mind', refund: { method: 'CASH' }
    }),
    /Only ₹449 of this bill was paid in money/, 'REFUND_OVER_MONEY_PAID');
  const cnMid2 = await prisma.invoiceSeries.findFirst({ where: { clientId: DEV_CLIENT_ID, kind: 'CREDIT_NOTE' }, select: { lastNumber: true } });
  eq('a return refused after its number was taken gives the number back', cnMid2?.lastNumber, cnMid?.lastNumber);

  const back = await createReturn(manager, split.sale.id, {
    onceKey: key('asha-sc'), lines: [{ saleLineId: splitCot.id, qty: 1 }], reason: 'Changed mind', refund: { method: 'STORE_CREDIT' }
  });
  eq('as store credit it is fine', back.creditNote.customer?.storeCreditPaise, 129900);

  // ==========================================================================================
  console.log('\nbills that cannot take a return yet');
  // ==========================================================================================
  const unsure = await sell('unsure', [{ itemId: cotton.id, qty: 1 }], [{ method: 'UPI', amountPaise: 129900, unconfirmed: true }], {}, manager);
  eq('a UPI still being checked blocks a refund, and says where to go', (await eligibility(manager, unsure.sale.id)).blocked?.code, 'PAYMENT_BEING_CHECKED');
  await refused('so nothing is refunded that never arrived',
    () => createReturn(manager, unsure.sale.id, { onceKey: key('unsure'), lines: [{ saleLineId: unsure.sale.lines[0].id, qty: 1 }], reason: 'Damaged', refund: { method: 'CASH' } }),
    /Payment checks first/, 'PAYMENT_BEING_CHECKED');
  await resolve(manager, unsure.sale.payments[0].id, { arrived: true, reference: 'UPI-ARRIVED-1' });
  eq('once it is confirmed, it can come back', (await eligibility(manager, unsure.sale.id)).blocked, null);

  const voided = await sell('voided', [{ itemId: cotton.id, qty: 1 }], [{ method: 'UPI', amountPaise: 129900, unconfirmed: true }], {}, manager);
  await resolve(manager, voided.sale.payments[0].id, { arrived: false });
  eq('a UPI that never arrived leaves money owed, and blocks a refund', (await eligibility(manager, voided.sale.id)).blocked?.code, 'MONEY_OWED');

  const saturday = new Date(); saturday.setDate(saturday.getDate() + 3);
  const keptDue = await sell('keptdue', [{ itemId: cotton.id, qty: 1 }], [cash(50000)], { kind: 'KEPT', customerId: priya.id, promisedAt: saturday }, manager);
  await refused('a kept order still owing money cannot be returned',
    () => createReturn(manager, keptDue.sale.id, { onceKey: key('keptdue'), lines: [{ saleLineId: keptDue.sale.lines[0].id, qty: 1 }], reason: 'Cancelled', refund: { method: 'CASH' } }),
    /₹799 is still owed/, 'MONEY_OWED');

  const keptPaid = await sell('keptpaid', [{ itemId: cotton.id, qty: 1 }], [cash(129900)], { kind: 'KEPT', customerId: priya.id, promisedAt: saturday }, manager);
  await createReturn(manager, keptPaid.sale.id, {
    onceKey: key('keptpaid'), lines: [{ saleLineId: keptPaid.sale.lines[0].id, qty: 1 }], reason: 'Customer cancelled', refund: { method: 'CASH' }
  });
  const waiting = await listOrders(manager, 'WAITING');
  ok('a paid kept order returned before collection leaves the Waiting list', !waiting.some(o => o.id === keptPaid.sale.id));
  await refused('and cannot be marked ready', () => markReady(manager, keptPaid.sale.id), /was returned/);

  // ==========================================================================================
  console.log('\nlate returns');
  // ==========================================================================================
  const old = await sell('old', [{ itemId: cotton.id, qty: 2 }], [cash(259800)], {}, manager);
  await prisma.sale.update({ where: { id: old.sale.id }, data: { createdAt: new Date(Date.now() - 10 * 86_400_000) } });
  const eOld = await eligibility(cashier, old.sale.id);
  eq('a 10-day-old bill is outside a 7-day window', [eOld.window.outside, eOld.window.daysSince], [true, 10]);
  eq('so a cashier needs the late-return approval', eOld.approvalNeeded, 'RETURN_OUTSIDE_WINDOW');
  await refused('without it, the message says how late',
    () => createReturn(cashier, old.sale.id, { onceKey: key('late0'), lines: [{ saleLineId: old.sale.lines[0].id, qty: 1 }], reason: 'Found a flaw', refund: { method: 'CASH' } }),
    /10 days old and the shop takes returns for 7/, 'APPROVAL_REQUIRED');
  __resetLockouts();
  await refused("a senior cashier's PIN cannot allow a late return",
    () => createReturn(cashier, old.sale.id, {
      onceKey: key('late0'), lines: [{ saleLineId: old.sale.lines[0].id, qty: 1 }], reason: 'Found a flaw', refund: { method: 'CASH' },
      approval: { pin: '4455', reason: 'She is a regular' }
    }),
    /not allowed to approve a return after the return window/, 'NOT_PERMITTED');
  __resetLockouts();
  const lateOk = await createReturn(cashier, old.sale.id, {
    onceKey: key('late1'), lines: [{ saleLineId: old.sale.lines[0].id, qty: 1 }], reason: 'Found a flaw', refund: { method: 'CASH' },
    approval: { pin: '2468', reason: 'Flaw in the weave, not her fault' }
  });
  eq('a manager PIN allows it, as a late-return approval',
    (await prisma.approval.findFirst({ where: { returnId: lateOk.creditNote.id } }))?.kind, 'RETURN_OUTSIDE_WINDOW');
  const lateOwn = await createReturn(manager, old.sale.id, {
    onceKey: key('late2'), lines: [{ saleLineId: old.sale.lines[0].id, qty: 1 }], reason: 'Found a flaw', refund: { method: 'CASH' }
  });
  const ownAudit = await prisma.auditLog.findFirst({ where: { subject: lateOwn.creditNote.creditNoteNo, action: 'approval.granted' } });
  eq('a manager taking a late return alone is still on the audit trail', (ownAudit?.detail as any)?.byOwnAuthority, true);

  const seven = await sell('seven', [{ itemId: blouse.id, qty: 1 }], [cash(44900)], {}, manager);
  const sevenAgo = new Date(); sevenAgo.setDate(sevenAgo.getDate() - 7); sevenAgo.setHours(9, 0, 0, 0);
  await prisma.sale.update({ where: { id: seven.sale.id }, data: { createdAt: sevenAgo } });
  eq('a bill from exactly 7 days ago is still inside', (await eligibility(cashier, seven.sale.id)).approvalNeeded, 'RETURN');

  // ==========================================================================================
  console.log('\nexchanges');
  // ==========================================================================================
  const orig = await sell('ex-orig', [{ itemId: silk.id, qty: 1 }], [cash(1299900)], { customerId: priya.id }, manager);
  const silkLine = orig.sale.lines[0].id;
  const cnEx0 = await prisma.invoiceSeries.findFirst({ where: { clientId: DEV_CLIENT_ID, kind: 'CREDIT_NOTE' }, select: { lastNumber: true } });

  await refused('paying the wrong difference is refused with the right one',
    () => createExchange(cashier, orig.sale.id, {
      onceKey: key('ex-up'), lines: [{ saleLineId: silkLine, qty: 1 }], reason: 'Wants the green one', approval: PIN,
      newSale: { counterId, lines: [{ itemId: silk2.id, qty: 1 }], payments: [cash(100000)] }
    }),
    /₹1,000 still to pay on a ₹2,000 bill/, 'AMOUNT_MISMATCH');
  const cnEx1 = await prisma.invoiceSeries.findFirst({ where: { clientId: DEV_CLIENT_ID, kind: 'CREDIT_NOTE' }, select: { lastNumber: true } });
  eq('and nothing of it was kept -- no credit note number used', cnEx1?.lastNumber, cnEx0?.lastNumber);
  eq('the original is untouched', (await getSale(cashier, orig.sale.id)).returns.length, 0);

  __resetLockouts();
  const up = await createExchange(cashier, orig.sale.id, {
    onceKey: key('ex-up'), lines: [{ saleLineId: silkLine, qty: 1 }], reason: 'Wants the green one', approval: PIN,
    newSale: { counterId, lines: [{ itemId: silk2.id, qty: 1 }], payments: [cash(200000)] }
  });
  ok('a dearer saree: the customer pays only the Rs 2,000 difference', up.sale?.payments.some((p: any) => p.method === 'CASH' && p.amountPaise === 200000) === true);
  eq('the rest is settled by what came back', up.sale?.payments.find((p: any) => p.method === 'EXCHANGE')?.amountPaise, 1299900);
  eq('the new bill is paid in full', up.sale?.owedPaise, 0);
  eq('the credit note says EXCHANGE', up.creditNote.refundMethod, 'EXCHANGE');
  eq('and points at the new bill', up.creditNote.exchangeSale?.id, up.sale?.id);
  eq('the new bill points back at the credit note', up.sale?.exchangedFrom?.creditNoteNo, up.creditNote.creditNoteNo);
  eq('the new bill belongs to the same customer', up.sale?.customer?.id, priya.id);
  eq('the original is fully returned', (await getSale(cashier, orig.sale.id)).status, 'RETURNED');

  const upAgain = await createExchange(cashier, orig.sale.id, {
    onceKey: key('ex-up'), lines: [{ saleLineId: silkLine, qty: 1 }], reason: 'Wants the green one', approval: PIN,
    newSale: { counterId, lines: [{ itemId: silk2.id, qty: 1 }], payments: [cash(200000)] }
  });
  ok('pressing it twice gives back the same exchange', upAgain.replayed && upAgain.sale?.id === up.sale?.id);
  eq('and only one new bill exists', await prisma.return.count({ where: { exchangeSaleId: up.sale!.id } }), 1);

  // Returning the saree taken IN the exchange: only the Rs 2,000 paid in money can go back as money.
  eq('the exchanged saree can go back as money only up to the difference paid',
    (await eligibility(manager, up.sale!.id)).moneyRefundablePaise, 200000);

  // Cheaper.
  const orig2 = await sell('ex-orig2', [{ itemId: silk.id, qty: 1 }], [cash(1299900)], { customerId: priya.id }, manager);
  await refused('a cheaper saree: the leftover needs somewhere to go',
    () => createExchange(manager, orig2.sale.id, {
      onceKey: key('ex-down'), lines: [{ saleLineId: orig2.sale.lines[0].id, qty: 1 }], reason: 'Too heavy',
      newSale: { counterId, lines: [{ itemId: cotton.id, qty: 1 }], payments: [] }
    }),
    /₹11,700 more than the new bill/, 'REFUND_METHOD_REQUIRED');
  await refused('and nothing more can be paid on a bill already covered',
    () => createExchange(manager, orig2.sale.id, {
      onceKey: key('ex-down'), lines: [{ saleLineId: orig2.sale.lines[0].id, qty: 1 }], reason: 'Too heavy',
      newSale: { counterId, lines: [{ itemId: cotton.id, qty: 1 }], payments: [cash(100)] }, refund: { method: 'CASH' }
    }),
    /Nothing more is to be paid/, 'NOTHING_TO_PAY');
  const down = await createExchange(manager, orig2.sale.id, {
    onceKey: key('ex-down'), lines: [{ saleLineId: orig2.sale.lines[0].id, qty: 1 }], reason: 'Too heavy',
    newSale: { counterId, lines: [{ itemId: cotton.id, qty: 1 }], payments: [] }, refund: { method: 'CASH' }
  });
  eq('the credit note shows what settled the new bill and what went back',
    down.creditNote.refunds.map((r: any) => [r.method, r.amountPaise]), [['EXCHANGE', 129900], ['CASH', 1170000]]);
  eq('the new bill is paid by exchange alone', down.sale?.payments.map((p: any) => p.method), ['EXCHANGE']);

  // Same price.
  const orig3 = await sell('ex-orig3', [{ itemId: blouse.id, qty: 1 }], [cash(44900)], {}, manager);
  const same = await createExchange(manager, orig3.sale.id, {
    onceKey: key('ex-same'), lines: [{ saleLineId: orig3.sale.lines[0].id, qty: 1 }], reason: 'Other size',
    newSale: { counterId, lines: [{ itemId: blouse2.id, qty: 1 }], payments: [] }
  });
  eq('the same price: nothing paid, nothing refunded', same.creditNote.refunds.map((r: any) => r.method), ['EXCHANGE']);
  eq('and the new bill has no customer, like the original', same.sale?.customer, null);

  // A discount over the limit on the new bill, by a cashier: one PIN covers both.
  const orig4 = await sell('ex-orig4', [{ itemId: silk.id, qty: 1 }], [cash(1299900)], {}, manager);
  __resetLockouts();
  const disc = await createExchange(cashier, orig4.sale.id, {
    onceKey: key('ex-disc'), lines: [{ saleLineId: orig4.sale.lines[0].id, qty: 1 }], reason: 'Wants the green one',
    approval: { pin: '2468', reason: 'Loyal customer, festival' },
    newSale: { counterId, lines: [{ itemId: silk2.id, qty: 1 }], billDiscountPaise: 200000, payments: [] }
  });
  eq('Rs 2,000 off the dearer saree means nothing more to pay', disc.sale?.owedPaise, 0);
  const kinds = await prisma.approval.findMany({
    where: { OR: [{ returnId: disc.creditNote.id }, { saleId: disc.sale!.id }] }, select: { kind: true }
  });
  eq('two approvals are recorded -- the return and the discount', kinds.map(k => k.kind).sort(), ['DISCOUNT_OVER_LIMIT', 'RETURN']);

  // A replacement no longer sold: the whole exchange is refused, including the credit note.
  await prisma.item.updateMany({ where: { clientId: DEV_CLIENT_ID, code: 'DUP-201' }, data: { active: false } });
  const dup = await item('DUP-201');
  const orig5 = await sell('ex-orig5', [{ itemId: blouse.id, qty: 1 }], [cash(44900)], {}, manager);
  await refused('a replacement that is no longer sold stops the whole exchange',
    () => createExchange(manager, orig5.sale.id, {
      onceKey: key('ex-gone'), lines: [{ saleLineId: orig5.sale.lines[0].id, qty: 1 }], reason: 'Other size',
      newSale: { counterId, lines: [{ itemId: dup.id, qty: 1 }], payments: [cash(205000)] }
    }),
    /no longer sold/);
  eq('and the original was not returned by half', (await getSale(manager, orig5.sale.id)).returns.length, 0);
  await prisma.item.updateMany({ where: { clientId: DEV_CLIENT_ID, code: 'DUP-201' }, data: { active: true } });

  // ==========================================================================================
  console.log('\nthe customer card, and Home');
  // ==========================================================================================
  const card = await customerDetail(manager, priya.id);
  ok('a fully exchanged bill shows as returned in her history', card.recent.some(r => r.status === 'RETURNED'));
  ok('her spend counts what she kept, not what came back', card.lifetimeSpentPaise > 0);

  const { customer: meena } = await findOrCreate(cashier, { phone: phone(), name: 'Meena (history test)' });
  const m1 = await sell('m1', [{ itemId: cotton.id, qty: 2 }], [cash(259800)], { customerId: meena.id }, manager);
  await createReturn(manager, m1.sale.id, {
    onceKey: key('m1r'), lines: [{ saleLineId: m1.sale.lines[0].id, qty: 1 }], reason: 'Changed mind', refund: { method: 'STORE_CREDIT' }
  });
  const mc = await customerDetail(manager, meena.id);
  eq('bought two, returned one: she has spent Rs 1,299', mc.lifetimeSpentPaise, 129900);
  eq('it is still one visit', mc.visitCount, 1);
  eq('the part-return is on the bill in her history', mc.recent[0].returnedPaise, 129900);
  eq('her credit shows, with the credit note that gave it', [mc.storeCreditPaise, mc.creditHistory[0]?.documentKind], [129900, 'CREDIT_NOTE']);

  const h0 = await homeSummary(manager);
  const m2 = await sell('m2', [{ itemId: blouse.id, qty: 1 }], [cash(44900)], {}, manager);
  const m2r = await createReturn(manager, m2.sale.id, {
    onceKey: key('m2r'), lines: [{ saleLineId: m2.sale.lines[0].id, qty: 1 }], reason: 'Wrong size', refund: { method: 'CASH' }
  });
  const h1 = await homeSummary(manager);
  eq('Home: a bill sold and returned today still counts as sold', h1.today.salesPaise - h0.today.salesPaise, 44900);
  eq('and the return is counted on its own line', h1.today.returnsPaise - h0.today.returnsPaise, 44900);
  eq('the return is the latest thing in the activity', [h1.activity[0].kind, h1.activity[0].id], ['RETURN', m2r.creditNote.id]);

  // ==========================================================================================
  console.log('\nanother shop');
  // ==========================================================================================
  const stranger: Actor = { ...manager, clientId: 'someone-else', id: null as any };
  await refused("another shop cannot see this bill's returns", () => eligibility(stranger, s3.sale.id), /not found/);
  await refused('or read a credit note', () => getReturn(stranger, r1.creditNote.id), /not found/);
  await refused('or return against it',
    () => createReturn(stranger, s3.sale.id, { onceKey: key('stranger'), lines: [{ saleLineId: l3.id, qty: 1 }], reason: 'Damaged', refund: { method: 'CASH' } }),
    /not found/);

  // ==========================================================================================
  console.log('\na kept order paid from store credit');
  // ==========================================================================================
  const { customer: lata } = await findOrCreate(cashier, { phone: phone(), name: 'Lata (collect test)' });
  const lg = await sell('lata-give', [{ itemId: cotton.id, qty: 1 }], [cash(129900)], { customerId: lata.id }, manager);
  await createReturn(manager, lg.sale.id, {
    onceKey: key('lata-cr'), lines: [{ saleLineId: lg.sale.lines[0].id, qty: 1 }], reason: 'Changed mind', refund: { method: 'STORE_CREDIT' }
  });
  const lk = await sell('lata-keep', [{ itemId: cotton.id, qty: 1 }], [], { kind: 'KEPT', customerId: lata.id }, manager);
  await collect(manager, lk.sale.id, { onceKey: key('lata-pay'), payments: [{ method: 'CREDIT', amountPaise: 129900 }] as any });
  const lk2 = await getSale(manager, lk.sale.id);
  eq('the balance is paid from her credit', lk2.owedPaise, 0);
  eq('and her credit is used up', (await prisma.customer.findUniqueOrThrow({ where: { id: lata.id } })).storeCreditPaise, 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
