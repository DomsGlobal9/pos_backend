/**
 * verify-payments -- UPI, card, split, and the rule about never asking twice. Phase 2.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:payments
 *
 * Two halves. The first exercises planPayments directly, because it is pure and every rule can be
 * cornered without a sale. The second puts those rules through a real transaction, because a rule
 * that holds in isolation and not in the database is not a rule.
 *
 * The case this file exists for:
 *
 *     A customer pays 4,500 rupees by UPI. The shop's phone has not dinged. The saree is in their
 *     hand and there is a queue behind them.
 *
 * A till with two buttons forces the cashier to either wave them off unpaid or ask them to send it
 * again. The second is the one that gets a shop a reputation. So there is a third answer.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor, PERMISSIONS } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale, getSale } from '../services/sale';
import { planPayments, collectedPaise, awaitingCheck, resolve } from '../services/payments';
import { seed } from './seed-dev';

const actor: Actor = {
  kind: 'USER', clientId: DEV_CLIENT_ID, id: 'dev-cashier', name: 'Dev cashier',
  roles: ['OWNER'], permissions: Object.values(PERMISSIONS)
};

const ALL: any[] = ['CASH', 'UPI', 'CARD'];

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = '') {
  if (condition) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
}

function eq(name: string, actual: unknown, expected: unknown) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function refused(name: string, run: () => unknown, expect: RegExp) {
  try {
    run();
    failed++;
    console.error(`  FAIL  ${name}\n          it was allowed, and should not have been`);
  } catch (error: any) {
    ok(name, expect.test(error.message ?? ''), `message was: ${error.message}`);
  }
}

async function refusedAsync(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run();
    failed++;
    console.error(`  FAIL  ${name}\n          it was allowed, and should not have been`);
  } catch (error: any) {
    ok(name, expect.test(error.message ?? ''), `message was: ${error.message}`);
  }
}

async function main() {
  console.log('\nverify-payments\n');
  const { counterId } = await seed();
  const items = await prisma.item.findMany({
    where: { clientId: DEV_CLIENT_ID, active: true },
    select: { id: true, code: true, pricePaise: true }
  });
  const cotton = items.find(i => i.code === 'COT-010')!;   // 1,299.00
  const blouse = items.find(i => i.code === 'BLO-101')!;   //   449.00
  const run = randomUUID().slice(0, 8);
  const key = (n: string) => `pay-${run}-${n}`;

  // ==========================================================================================
  console.log('the split has to add up');
  // ==========================================================================================
  const exact = planPayments(100000, [{ method: 'CASH', amountPaise: 100000 }], ALL);
  eq('one cash payment for the whole bill', exact.length, 1);

  const split = planPayments(100000, [
    { method: 'CASH', amountPaise: 40000 },
    { method: 'UPI', amountPaise: 60000, reference: 'UPI-1' }
  ], ALL);
  eq('cash plus UPI', split.map(p => p.amountPaise), [40000, 60000]);

  const three = planPayments(100000, [
    { method: 'CASH', amountPaise: 30000 },
    { method: 'UPI', amountPaise: 30000, reference: 'U' },
    { method: 'CARD', amountPaise: 40000, reference: 'C' }
  ], ALL);
  eq('three ways', three.length, 3);

  refused('short by an exact amount, and it says which',
    () => planPayments(100000, [{ method: 'CASH', amountPaise: 90000 }], ALL),
    /₹100 still to pay/);

  refused('over by an exact amount, and it says which',
    () => planPayments(100000, [{ method: 'CASH', amountPaise: 110000 }], ALL),
    /₹100 more than/);

  refused('a split that is one paisa short is still short',
    () => planPayments(100000, [
      { method: 'CASH', amountPaise: 50000 },
      { method: 'UPI', amountPaise: 49999, reference: 'U' }
    ], ALL),
    /still to pay/);

  refused('nothing paid at all', () => planPayments(100000, [], ALL), /Nothing has been paid/);

  // ==========================================================================================
  console.log('\nwhat the shop has turned on');
  // ==========================================================================================
  refused('a method the shop does not take',
    () => planPayments(100000, [{ method: 'CARD', amountPaise: 100000, reference: 'C' }], ['CASH', 'UPI'] as any),
    /not set up to take card/);

  const noSettings = planPayments(100000, [{ method: 'CARD', amountPaise: 100000, reference: 'C' }], []);
  eq('a shop with no methods configured is not blocked from selling', noSettings.length, 1);

  // ==========================================================================================
  console.log('\nreferences');
  // ==========================================================================================
  refused('UPI marked collected needs a reference',
    () => planPayments(100000, [{ method: 'UPI', amountPaise: 100000 }], ALL),
    /Add the UPI reference/);

  refused('so does card',
    () => planPayments(100000, [{ method: 'CARD', amountPaise: 100000 }], ALL),
    /Add the card reference/);

  refused('and a reference of only spaces is not a reference',
    () => planPayments(100000, [{ method: 'UPI', amountPaise: 100000, reference: '   ' }], ALL),
    /Add the UPI reference/);

  const cashNoRef = planPayments(100000, [{ method: 'CASH', amountPaise: 100000 }], ALL);
  eq('cash needs none', cashNoRef[0].reference, null);

  // ==========================================================================================
  console.log('\nthe rule this phase exists for');
  // ==========================================================================================
  /*
   * A UPI that has not shown up on the shop's phone yet. The cashier has no reference to write
   * down -- that is exactly WHY it is unconfirmed -- so demanding one would force them to invent
   * a reference or mark a real payment as failed.
   */
  const unsure = planPayments(100000, [{ method: 'UPI', amountPaise: 100000, unconfirmed: true }], ALL);
  eq('an unconfirmed UPI is allowed with no reference', unsure[0].status, 'NEEDS_CHECKING');

  const unsureCard = planPayments(100000, [{ method: 'CARD', amountPaise: 100000, unconfirmed: true }], ALL);
  eq('and an unconfirmed card', unsureCard[0].status, 'NEEDS_CHECKING');

  refused('but cash can never be unconfirmed -- it is in the drawer or it is not',
    () => planPayments(100000, [{ method: 'CASH', amountPaise: 100000, unconfirmed: true }], ALL),
    /Cash is either taken or it is not/);

  const mixed = planPayments(100000, [
    { method: 'CASH', amountPaise: 40000 },
    { method: 'UPI', amountPaise: 60000, unconfirmed: true }
  ], ALL);
  eq('a split can be half certain', mixed.map(p => p.status), ['COLLECTED', 'NEEDS_CHECKING']);
  eq('and only the certain half counts as money in', collectedPaise(mixed as any), 40000);

  // ==========================================================================================
  console.log('\ncash, tendered and change');
  // ==========================================================================================
  const change = planPayments(129900, [{ method: 'CASH', amountPaise: 129900, tenderedPaise: 200000 }], ALL);
  eq('change is worked out', change[0].changePaise, 70100);

  const noTender = planPayments(129900, [{ method: 'CASH', amountPaise: 129900 }], ALL);
  eq('no tendered figure means no change figure, not zero', noTender[0].changePaise, null);

  refused('less handed over than the payment claims',
    () => planPayments(129900, [{ method: 'CASH', amountPaise: 129900, tenderedPaise: 100000 }], ALL),
    /Only ₹1,000 was handed over/);

  const upiTender = planPayments(100000, [{ method: 'UPI', amountPaise: 100000, reference: 'U', tenderedPaise: 200000 }], ALL);
  eq('tendered is ignored on a UPI payment', upiTender[0].tenderedPaise, null);

  // ==========================================================================================
  console.log('\nnow through a real sale');
  // ==========================================================================================
  const splitSale = await completeSale(actor, {
    onceKey: key('split'),
    counterId,
    lines: [{ itemId: cotton.id, qty: 1 }, { itemId: blouse.id, qty: 1 }],
    payments: [
      { method: 'CASH', amountPaise: 100000, tenderedPaise: 100000 },
      { method: 'UPI', amountPaise: 74800, reference: 'UPI-REF-99' }
    ]
  });
  eq('a split sale writes two payment rows', splitSale.sale.payments.length, 2);
  eq('and they add up to the bill',
    splitSale.sale.payments.reduce((t: number, p: any) => t + p.amountPaise, 0),
    splitSale.sale.totalPaise);
  eq('both are collected', splitSale.sale.payments.map((p: any) => p.status), ['COLLECTED', 'COLLECTED']);
  eq('the UPI reference is kept',
    splitSale.sale.payments.find((p: any) => p.method === 'UPI')?.reference, 'UPI-REF-99');

  await refusedAsync('a split that does not add up is refused by the sale too',
    () => completeSale(actor, {
      onceKey: key('split-bad'), counterId,
      lines: [{ itemId: blouse.id, qty: 1 }],
      payments: [
        { method: 'CASH', amountPaise: 20000 },
        { method: 'UPI', amountPaise: 20000, reference: 'U' }
      ]
    }),
    /still to pay|more than/);

  await refusedAsync('and a UPI with no reference is refused by the sale too',
    () => completeSale(actor, {
      onceKey: key('noref'), counterId,
      lines: [{ itemId: blouse.id, qty: 1 }],
      payments: [{ method: 'UPI', amountPaise: 44900 }]
    }),
    /Add the UPI reference/);

  // ==========================================================================================
  console.log('\na sale nobody is sure about');
  // ==========================================================================================
  const unsureSale = await completeSale(actor, {
    onceKey: key('unsure'),
    counterId,
    lines: [{ itemId: cotton.id, qty: 1 }],
    payments: [{ method: 'UPI', amountPaise: 129900, unconfirmed: true }]
  });
  ok('the sale still completes -- the customer is leaving with the saree',
    unsureSale.sale.invoiceNo.length > 0);
  eq('the payment is marked for checking', unsureSale.sale.payments[0].status, 'NEEDS_CHECKING');
  eq('the bill total is unchanged', unsureSale.sale.totalPaise, 129900);

  const worklist = await awaitingCheck(actor);
  const mine = worklist.find(p => p.saleId === unsureSale.sale.id);
  ok('it appears on the list of things to check', Boolean(mine));
  eq('with its invoice number, so it can be found', mine?.invoiceNo, unsureSale.sale.invoiceNo);

  // ==========================================================================================
  console.log('\nchecking it against the bank');
  // ==========================================================================================
  const arrived = await resolve(actor, mine!.id, { arrived: true, reference: 'UPI-LATE-77', note: 'Found on the statement' });
  eq('the money was there after all', arrived.status, 'COLLECTED');

  const afterResolve = await getSale(actor, unsureSale.sale.id);
  eq('the bill now shows it collected', afterResolve.payments[0].status, 'COLLECTED');
  eq('with the reference that was finally available', afterResolve.payments[0].reference, 'UPI-LATE-77');
  ok('and who checked it, and when', Boolean(afterResolve.payments[0].checkedAt));

  await refusedAsync('it cannot be resolved twice',
    () => resolve(actor, mine!.id, { arrived: true }),
    /already confirmed/);

  // The other outcome: it never arrived.
  const lostSale = await completeSale(actor, {
    onceKey: key('lost'), counterId,
    lines: [{ itemId: blouse.id, qty: 1 }],
    payments: [{ method: 'UPI', amountPaise: 44900, unconfirmed: true }]
  });
  const lost = (await awaitingCheck(actor)).find(p => p.saleId === lostSale.sale.id)!;
  const written = await resolve(actor, lost.id, { arrived: false, note: 'Nothing on the statement' });
  eq('a payment that never arrived is written off, not deleted', written.status, 'VOID');

  const afterVoid = await getSale(actor, lostSale.sale.id);
  eq('the bill keeps the row', afterVoid.payments.length, 1);
  eq('marked void', afterVoid.payments[0].status, 'VOID');
  eq('and the bill is genuinely short by that much',
    collectedPaise(afterVoid.payments as any), 0);

  await refusedAsync('a collected payment cannot be voided from this path',
    () => resolve(actor, splitSale.sale.payments[0].id, { arrived: false }),
    /already confirmed/);

  await refusedAsync('another shop cannot resolve this one',
    () => resolve({ ...actor, clientId: 'some-other-shop' }, lost.id, { arrived: true }),
    /not found/i);

  const otherWorklist = await awaitingCheck({ ...actor, clientId: 'some-other-shop' });
  eq('and sees an empty worklist', otherWorklist.length, 0);

  // ==========================================================================================
  console.log('\nretrying a split sale');
  // ==========================================================================================
  const again = await completeSale(actor, {
    onceKey: key('split'),
    counterId,
    lines: [{ itemId: cotton.id, qty: 1 }, { itemId: blouse.id, qty: 1 }],
    payments: [
      { method: 'CASH', amountPaise: 100000, tenderedPaise: 100000 },
      { method: 'UPI', amountPaise: 74800, reference: 'UPI-REF-99' }
    ]
  });
  ok('a retried split sale replays', again.replayed === true);
  eq('and still has exactly two payment rows', again.sale.payments.length, 2);

  const rows = await prisma.payment.count({
    where: { clientId: DEV_CLIENT_ID, saleId: splitSale.sale.id }
  });
  eq('no duplicate payment rows were written', rows, 2);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nthe suite itself broke:\n', error);
  await prisma.$disconnect();
  process.exit(1);
});
