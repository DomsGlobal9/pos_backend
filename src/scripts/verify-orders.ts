/**
 * verify-orders -- goods kept for a customer, money owed, handing over. Phase 5.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:orders
 *
 * The situation this exists for: a customer buys a silk saree, leaves it for fall and pico and a
 * blouse to be stitched, pays 2,000 now, and will collect on Saturday. Between now and Saturday the
 * shop has to know it is waiting, then that it is ready, how much is still owed, and -- when she
 * comes -- whether it is all right to hand it over.
 *
 * The two cases that would cost a shop real money if they were wrong:
 *
 *   - two cashiers collecting the same balance at the same moment
 *   - a UPI still being checked showing up as "owed", so somebody asks her to pay it again
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale } from '../services/sale';
import { list, collect, markReady, handOver, needsAttention } from '../services/orders';
import { resolve, awaitingCheck } from '../services/payments';
import { findOrCreate, detail as customerDetail } from '../services/customers';
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

async function main() {
  console.log('\nverify-orders\n');
  const { counterId } = await seed();
  const cashier = await actorFor('dev-cashier');

  const saree = await prisma.item.findFirstOrThrow({
    where: { clientId: DEV_CLIENT_ID, code: 'COT-010' }, select: { id: true, pricePaise: true }
  }); // 1,299.00
  const run = randomUUID().slice(0, 8);
  const key = (n: string) => `ord-${run}-${n}`;

  const { customer } = await findOrCreate(cashier, {
    phone: '9' + String(Date.now()).slice(-9), name: 'Priya (orders test)'
  });

  const saturday = new Date();
  saturday.setDate(saturday.getDate() + 3);

  /** Keep one saree for Priya with the given advance payments. */
  const keep = (name: string, payments: any[], extra: any = {}) => completeSale(cashier, {
    onceKey: key(name),
    counterId,
    kind: 'KEPT',
    customerId: customer.id,
    lines: [{ itemId: saree.id, qty: 1 }],
    payments,
    promisedAt: saturday,
    note: 'Fall and pico, blouse to be stitched',
    ...extra
  });

  // ==========================================================================================
  console.log('keeping something for a customer');
  // ==========================================================================================
  await refused('needs to know who it is being kept for',
    () => completeSale(cashier, {
      onceKey: key('nocust'), counterId, kind: 'KEPT',
      lines: [{ itemId: saree.id, qty: 1 }], payments: []
    }),
    /needs a customer/, 'CUSTOMER_REQUIRED');

  const kept = await keep('main', [{ method: 'CASH', amountPaise: 50000 }]);
  eq('a 500 advance on a 1,299 saree is taken', kept.sale.payments.length, 1);
  eq('it is kept, not handed over', kept.sale.fulfilment, 'WAITING');
  eq('and 799 is still owed', kept.sale.owedPaise, 79900);
  eq('so the bill is due', kept.sale.status, 'BALANCE_DUE');
  ok('it has an invoice number -- a kept order is a real sale', /^INV\//.test(kept.sale.invoiceNo));
  eq('the note is kept', kept.sale.note, 'Fall and pico, blouse to be stitched');
  ok('and so is the collection date', Boolean(kept.sale.promisedAt));

  const noAdvance = await keep('noadvance', []);
  eq('a trusted regular can leave it with no advance at all', noAdvance.sale.owedPaise, 129900);

  const paidUp = await keep('paidup', [{ method: 'CASH', amountPaise: 129900 }]);
  eq('paid in full but still at the tailor\'s: not due', paidUp.sale.status, 'COMPLETED');
  eq('and still waiting', paidUp.sale.fulfilment, 'WAITING');

  await refused('an advance bigger than the bill',
    () => keep('toomuch', [{ method: 'CASH', amountPaise: 150000 }]),
    /more than the ₹1,299 bill/);

  const yesterday = new Date(Date.now() - 86_400_000);
  await refused('a collection date that has already passed',
    () => keep('pastdate', [], { promisedAt: yesterday }),
    /already passed/);

  // A normal counter sale is untouched by any of this.
  const counter = await completeSale(cashier, {
    onceKey: key('counter'), counterId,
    lines: [{ itemId: saree.id, qty: 1 }],
    payments: [{ method: 'CASH', amountPaise: 129900 }]
  });
  eq('a counter sale is handed over the moment it is made', counter.sale.fulfilment, 'HANDED_OVER');
  await refused('and still has to be paid in full',
    () => completeSale(cashier, {
      onceKey: key('counter-short'), counterId,
      lines: [{ itemId: saree.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 50000 }]
    }),
    /still to pay/);

  // ==========================================================================================
  console.log('\nthe Orders screen');
  // ==========================================================================================
  const waiting = await list(cashier, 'WAITING');
  ok('it appears under Waiting', waiting.some(o => o.id === kept.sale.id));
  const due = await list(cashier, 'DUE');
  ok('and under Due -- both at once, because both are true', due.some(o => o.id === kept.sale.id));
  const complete = await list(cashier, 'COMPLETE');
  ok('and not under Complete', !complete.some(o => o.id === kept.sale.id));

  const everywhere = [...waiting, ...due, ...complete, ...(await list(cashier, 'ALL'))];
  ok('a counter sale never appears on the Orders screen at all',
    !everywhere.some(o => o.id === counter.sale.id));

  ok('paid up but still waiting is Waiting, not Due',
    waiting.some(o => o.id === paidUp.sale.id) && !due.some(o => o.id === paidUp.sale.id));

  const found = await list(cashier, 'ALL', 'Priya (orders');
  ok('found by the customer\'s name', found.some(o => o.id === kept.sale.id));
  const byInvoice = await list(cashier, 'ALL', kept.sale.invoiceNo.slice(-4));
  ok('and by the tail of the invoice number', byInvoice.some(o => o.id === kept.sale.id));

  // Soonest promise first -- the order a shop actually works through them in.
  const sooner = new Date(); sooner.setDate(sooner.getDate() + 1);
  const soon = await keep('soon', [], { promisedAt: sooner });
  const ordered = (await list(cashier, 'WAITING')).map(o => o.id);
  ok('the one promised for tomorrow is above the one promised for Saturday',
    ordered.indexOf(soon.sale.id) < ordered.indexOf(kept.sale.id));

  // Overdue can only be made by time passing, so the clock is moved here -- in the test setup, not
  // in the thing being tested.
  const late = await keep('late', []);
  await prisma.sale.update({ where: { id: late.sale.id }, data: { promisedAt: yesterday } });
  const lateRow = (await list(cashier, 'WAITING')).find(o => o.id === late.sale.id);
  eq('a promise that has passed is flagged overdue', lateRow?.overdue, true);
  eq('one that has not, is not', (await list(cashier, 'WAITING')).find(o => o.id === kept.sale.id)?.overdue, false);

  // ==========================================================================================
  console.log('\nshe pays some more');
  // ==========================================================================================
  const part = await collect(cashier, kept.sale.id, {
    onceKey: key('collect-1'),
    payments: [{ method: 'CASH', amountPaise: 30000 }]
  });
  eq('300 more comes off what is owed', part.order.owedPaise, 49900);

  await refused('she cannot be charged more than she owes',
    () => collect(cashier, kept.sale.id, { onceKey: key('collect-over'), payments: [{ method: 'CASH', amountPaise: 60000 }] }),
    /Only ₹499 is still owed/, 'OVERPAYMENT');

  const again = await collect(cashier, kept.sale.id, {
    onceKey: key('collect-1'),
    payments: [{ method: 'CASH', amountPaise: 30000 }]
  });
  ok('the same collection pressed twice is recorded once', again.replayed === true);
  eq('and nothing extra came off', again.order.owedPaise, 49900);

  const split = await collect(cashier, kept.sale.id, {
    onceKey: key('collect-split'),
    payments: [
      { method: 'CASH', amountPaise: 19900 },
      { method: 'UPI', amountPaise: 30000, reference: 'UPI-ORD-1' }
    ]
  });
  eq('the rest, split across cash and UPI, clears it', split.order.owedPaise, 0);
  const cleared = await prisma.sale.findUniqueOrThrow({ where: { id: kept.sale.id }, select: { status: true } });
  eq('and the bill is no longer due', cleared.status, 'COMPLETED');

  await refused('nothing more can be collected once it is clear',
    () => collect(cashier, kept.sale.id, { onceKey: key('collect-extra'), payments: [{ method: 'CASH', amountPaise: 100 }] }),
    /Nothing is owed/, 'NOTHING_OWED');

  await refused('a counter sale has nothing to collect',
    () => collect(cashier, counter.sale.id, { onceKey: key('collect-counter'), payments: [{ method: 'CASH', amountPaise: 100 }] }),
    /taken at the counter/);

  await refused('another shop cannot collect on it',
    () => collect({ ...cashier, clientId: 'some-other-shop' }, noAdvance.sale.id,
      { onceKey: key('collect-tenant'), payments: [{ method: 'CASH', amountPaise: 100 }] }),
    /not found/);

  // ==========================================================================================
  console.log('\ntwo cashiers, one balance, the same moment');
  // ==========================================================================================
  /*
   * Without the row lock, both read "1,299 owed", both take 1,299, and the customer has paid twice
   * for one saree. Five at once, each trying to take the whole balance.
   */
  const racers = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => collect(cashier, noAdvance.sale.id, {
      onceKey: key(`race-${i}`),
      payments: [{ method: 'CASH', amountPaise: 129900 }]
    }))
  );
  eq('exactly one of five succeeds', racers.filter(r => r.status === 'fulfilled').length, 1);
  const paidIn = await prisma.payment.aggregate({
    where: { saleId: noAdvance.sale.id }, _sum: { amountPaise: true }
  });
  eq('and she has paid the saree\'s price exactly once', paidIn._sum.amountPaise, 129900);

  // ==========================================================================================
  console.log('\nmoney being checked is not money owed');
  // ==========================================================================================
  const checking = await keep('checking', [{ method: 'CASH', amountPaise: 29900 }]);
  const pending = await collect(cashier, checking.sale.id, {
    onceKey: key('checking-upi'),
    payments: [{ method: 'UPI', amountPaise: 100000, unconfirmed: true }]
  });
  /*
   * She sent 1,000 by UPI and the shop's phone has not dinged. If this showed 1,000 owed, the
   * Orders screen would tell the next cashier to ask her for it -- the one thing the till must
   * never do. It is the bank's question, not hers.
   */
  eq('an unconfirmed UPI is NOT shown as owed', pending.order.owedPaise, 0);
  ok('so the order is not under Due', !(await list(cashier, 'DUE')).some(o => o.id === checking.sale.id));

  // And the other way: the bank says it never arrived.
  const toCheck = (await awaitingCheck(cashier)).find(p => p.saleId === checking.sale.id)!;
  await resolve(cashier, toCheck.id, { arrived: false, note: 'Not on the statement' });
  const afterVoid = await prisma.sale.findUniqueOrThrow({
    where: { id: checking.sale.id }, select: { status: true }
  });
  /*
   * Found while writing this phase, not reported: before refreshMoneyStatus existed, resolving a
   * payment as never-arrived left the bill saying COMPLETED while money was genuinely owed on it.
   */
  eq('once the bank says it never arrived, the order IS due again', afterVoid.status, 'BALANCE_DUE');
  ok('and back under Due', (await list(cashier, 'DUE')).some(o => o.id === checking.sale.id));

  // ==========================================================================================
  console.log('\nready, and handing over');
  // ==========================================================================================
  const ready = await markReady(cashier, kept.sale.id);
  eq('the tailor sends it back -- ready', ready.order.fulfilment, 'READY');
  const readyTwice = await markReady(cashier, kept.sale.id);
  eq('pressing ready twice is not an error', readyTwice.order.fulfilment, 'READY');
  ok('it moves from Waiting to Ready', (await list(cashier, 'READY')).some(o => o.id === kept.sale.id)
    && !(await list(cashier, 'WAITING')).some(o => o.id === kept.sale.id));

  const handed = await handOver(cashier, kept.sale.id);
  eq('paid in full, it is handed over without a question', handed.order.fulfilment, 'HANDED_OVER');
  ok('and it is Complete', (await list(cashier, 'COMPLETE')).some(o => o.id === kept.sale.id));
  const plain = await prisma.sale.findUniqueOrThrow({
    where: { id: kept.sale.id }, select: { handoverDuePaise: true, handedOverById: true }
  });
  eq('with nothing owed recorded against the handover', plain.handoverDuePaise, null);
  eq('and who handed it over', plain.handedOverById, 'dev-cashier');

  await refused('it cannot be handed over twice',
    () => handOver(cashier, kept.sale.id), /already handed over/, 'ALREADY_HANDED_OVER');
  await refused('nor marked ready after it has gone',
    () => markReady(cashier, kept.sale.id), /already handed over/);

  // With money still owed.
  const owing = await keep('owing', [{ method: 'CASH', amountPaise: 50000 }]);
  await refused('with money owed, it is refused -- and says how much',
    () => handOver(cashier, owing.sale.id),
    /₹799 is still owed/, 'HANDOVER_WITH_DUE');

  const trusted = await handOver(cashier, owing.sale.id, { acceptDue: true });
  eq('a trusted regular can take it anyway, when someone says so', trusted.order.fulfilment, 'HANDED_OVER');
  const trustRecord = await prisma.sale.findUniqueOrThrow({
    where: { id: owing.sale.id }, select: { handoverDuePaise: true }
  });
  eq('and what was owed at that moment is recorded', trustRecord.handoverDuePaise, 79900);
  ok('it stays under Due, because she still owes it', (await list(cashier, 'DUE')).some(o => o.id === owing.sale.id));
  ok('and is NOT Complete', !(await list(cashier, 'COMPLETE')).some(o => o.id === owing.sale.id));
  const trustAudit = await prisma.auditLog.findFirst({
    where: { clientId: DEV_CLIENT_ID, action: 'order.handed_over_with_due', subject: owing.sale.invoiceNo },
    select: { actorName: true }
  });
  eq('and the decision is in the audit trail, with a name', trustAudit?.actorName, 'Dev cashier');

  const early = await keep('early', [{ method: 'CASH', amountPaise: 129900 }]);
  const straight = await handOver(cashier, early.sale.id);
  eq('she arrives early and it is already done: straight from Waiting to handed over',
    straight.order.fulfilment, 'HANDED_OVER');

  // ==========================================================================================
  console.log('\nwhat Home and the customer card say');
  // ==========================================================================================
  const attention = await needsAttention(cashier);
  ok('Home counts the overdue ones', attention.overdue >= 1);
  ok('and the ones with money due', attention.dueCount >= 1 && attention.duePaise > 0);

  /*
   * Counted from the orders THIS run made, by id. The first version filtered the Due list by the
   * customer's NAME -- and every run creates a new customer with the same name, so from the second
   * run on it added up other people's debts. It passed once and failed on the rerun, which is the
   * worst kind of test: the code was right, the check was not.
   */
  const card = await customerDetail(cashier, customer.id);
  const mine = new Set([
    kept.sale.id, noAdvance.sale.id, paidUp.sale.id, soon.sale.id,
    late.sale.id, checking.sale.id, owing.sale.id, early.sale.id
  ]);
  const expectedOwed = (await list(cashier, 'DUE'))
    .filter(o => mine.has(o.id))
    .reduce((sum, o) => sum + o.owedPaise, 0);
  eq('her card shows what she owes across every order', card.owedPaise, expectedOwed);
  ok('which is more than nothing', card.owedPaise > 0);

  // ==========================================================================================
  console.log('\nthe same rule reaches a counter sale');
  // ==========================================================================================
  /*
   * refreshMoneyStatus is not only for kept orders. A counter sale paid by a UPI that later turns
   * out never to have arrived is genuinely short, and its bill has to say so.
   */
  const counterUnsure = await completeSale(cashier, {
    onceKey: key('counter-unsure'), counterId,
    lines: [{ itemId: saree.id, qty: 1 }],
    payments: [{ method: 'UPI', amountPaise: 129900, unconfirmed: true }]
  });
  eq('it completes while being checked', counterUnsure.sale.status, 'COMPLETED');
  const counterPending = (await awaitingCheck(cashier)).find(p => p.saleId === counterUnsure.sale.id)!;
  await resolve(cashier, counterPending.id, { arrived: false });
  const counterAfter = await prisma.sale.findUniqueOrThrow({
    where: { id: counterUnsure.sale.id }, select: { status: true }
  });
  eq('and says it is short once the bank says no', counterAfter.status, 'BALANCE_DUE');
  ok('but it is still not an order', !(await list(cashier, 'ALL')).some(o => o.id === counterUnsure.sale.id));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nthe suite itself broke:\n', error);
  await prisma.$disconnect();
  process.exit(1);
});
