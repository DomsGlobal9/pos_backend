/**
 * verify-held-bills -- park a basket, serve someone else, bring it back exactly. Phase 5.
 *
 *     npm run verify:held-bills
 *
 * The case that matters: two cashiers tap the same parked bill at the same moment. If both get it,
 * one customer's saree is rung up at two tills.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor, PERMISSIONS } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { park, list, recall, discard } from '../services/held-bills';
import { completeSale } from '../services/sale';
import { seed } from './seed-dev';

const actor: Actor = {
  kind: 'USER', clientId: DEV_CLIENT_ID, id: 'dev-cashier', name: 'Dev cashier',
  roles: ['CASHIER'], permissions: [PERMISSIONS.SELL]
};

let passed = 0;
let failed = 0;

const ok = (name: string, condition: boolean, detail = '') => {
  if (condition) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

async function refused(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run();
    failed++;
    console.error(`  FAIL  ${name}\n          it was allowed, and should not have been`);
  } catch (error: any) {
    ok(name, expect.test(error.message ?? ''), `message was: ${error.message}`);
  }
}

async function main() {
  console.log('\nverify-held-bills\n');
  const { counterId } = await seed();
  // Start clean: parked bills from earlier runs would otherwise fill the 50-bill ceiling.
  await prisma.heldBill.deleteMany({ where: { clientId: DEV_CLIENT_ID } });

  const saree = await prisma.item.findFirstOrThrow({
    where: { clientId: DEV_CLIENT_ID, code: 'KAN-001' }, select: { id: true, pricePaise: true }
  });
  const blouse = await prisma.item.findFirstOrThrow({
    where: { clientId: DEV_CLIENT_ID, code: 'BLO-101' }, select: { id: true, pricePaise: true }
  });

  const basket = {
    lines: [
      { id: saree.id, qty: 1, name: 'Kanchipuram silk saree', pricePaise: saree.pricePaise },
      { id: blouse.id, qty: 2, name: 'Blouse piece', pricePaise: blouse.pricePaise, overridePricePaise: 40000 }
    ],
    customer: { id: 'cust-x', name: 'Meera' },
    billDiscountPaise: 5000,
    onceKey: `till-${randomUUID()}`
  };

  // ------------------------------------------------------------------------------------------
  console.log('putting a bill down');
  // ------------------------------------------------------------------------------------------
  const parked = await park(actor, { counterId, payload: basket });
  eq('it is labelled with the customer, so a cashier recognises it', parked.label, 'Meera');
  eq('and counts the pieces on it', parked.itemCount, 3);
  eq('and says who parked it', parked.parkedBy, 'Dev cashier');

  const anon = await park(actor, { counterId, payload: { lines: [{ id: blouse.id, qty: 1 }] } });
  ok('with no customer, it is labelled with the time, never an id', anon.label.startsWith('Parked at'));

  const named = await park(actor, { counterId, label: 'Lady in green', payload: { lines: [{ id: blouse.id, qty: 1 }] } });
  eq('or with whatever the cashier types', named.label, 'Lady in green');

  await refused('an empty basket cannot be parked',
    () => park(actor, { counterId, payload: { lines: [] } }), /nothing on this bill/);
  await refused('nor at a till that does not exist',
    () => park(actor, { counterId: randomUUID(), payload: basket }), /till was not found/);

  // ------------------------------------------------------------------------------------------
  console.log('\nthe list');
  // ------------------------------------------------------------------------------------------
  const all = await list(actor);
  eq('every parked bill in the shop is listed', all.length, 3);
  eq('oldest first -- the one waiting longest', all[0].id, parked.id);
  ok('with the counter it was parked at', all.every(h => h.counterName === 'Counter 1'));

  // Another cashier sees the same list: it belongs to the shift, not to one person.
  const colleague: Actor = { ...actor, id: 'dev-senior', name: 'Ravi (senior cashier)' };
  eq('a colleague sees the same parked bills', (await list(colleague)).length, 3);

  const otherShop: Actor = { ...actor, clientId: 'some-other-shop' };
  eq('another shop sees none of them', (await list(otherShop)).length, 0);

  // ------------------------------------------------------------------------------------------
  console.log('\nbringing it back');
  // ------------------------------------------------------------------------------------------
  const back = await recall(actor, parked.id);
  eq('it comes back exactly as it was -- every line', back.lines.length, 2);
  eq('with the quantities', back.lines.map(l => l.qty), [1, 2]);
  eq('with a price change still on it', (back.lines[1] as any).overridePricePaise, 40000);
  eq('with the customer', back.customer?.name, 'Meera');
  eq('with the discount', back.billDiscountPaise, 5000);
  eq('and with the SAME once-key, so a retried sale cannot become two', back.onceKey, basket.onceKey);
  ok('and it is off the list', !(await list(actor)).some(h => h.id === parked.id));

  await refused('it cannot be recalled a second time',
    () => recall(actor, parked.id), /already taken that bill back/);

  // ------------------------------------------------------------------------------------------
  console.log('\ntwo cashiers, one parked bill, the same moment');
  // ------------------------------------------------------------------------------------------
  const contested = await park(actor, { counterId, label: 'Contested', payload: basket });
  const grabs = await Promise.allSettled(
    Array.from({ length: 6 }, () => recall(actor, contested.id))
  );
  eq('exactly one of six gets it', grabs.filter(g => g.status === 'fulfilled').length, 1);
  ok('the rest are told someone else has it',
    grabs.filter(g => g.status === 'rejected')
      .every(g => /already taken/.test((g as PromiseRejectedResult).reason?.message ?? '')));

  // ------------------------------------------------------------------------------------------
  console.log('\na parked bill is not a sale');
  // ------------------------------------------------------------------------------------------
  const salesBefore = await prisma.sale.count({ where: { clientId: DEV_CLIENT_ID } });
  const seriesBefore = await prisma.invoiceSeries.findFirst({
    where: { clientId: DEV_CLIENT_ID, kind: 'INVOICE' }, select: { lastNumber: true }
  });
  const draft = await park(actor, { counterId, label: 'Just a draft', payload: basket });
  eq('parking makes no sale', await prisma.sale.count({ where: { clientId: DEV_CLIENT_ID } }), salesBefore);
  eq('and uses no invoice number',
    (await prisma.invoiceSeries.findFirst({ where: { clientId: DEV_CLIENT_ID, kind: 'INVOICE' }, select: { lastNumber: true } }))?.lastNumber,
    seriesBefore?.lastNumber);

  await discard(actor, draft.id);
  ok('it can be thrown away', !(await list(actor)).some(h => h.id === draft.id));
  await refused('once', () => discard(actor, draft.id), /already gone/);
  await refused('and another shop cannot throw ours away',
    () => discard(otherShop, anon.id), /already gone/);
  ok('which is still there', (await list(actor)).some(h => h.id === anon.id));

  // ------------------------------------------------------------------------------------------
  console.log('\nrecalled, then sold');
  // ------------------------------------------------------------------------------------------
  const toSell = await park(actor, {
    counterId, label: 'Will be sold',
    payload: { lines: [{ id: blouse.id, qty: 1 }], onceKey: `till-${randomUUID()}` }
  });
  const recalled = await recall(actor, toSell.id);
  const sold = await completeSale(actor, {
    onceKey: recalled.onceKey!,
    counterId,
    lines: recalled.lines.map(l => ({ itemId: l.id, qty: l.qty })),
    payments: [{ method: 'CASH', amountPaise: blouse.pricePaise }]
  });
  ok('a recalled bill is sold like any other', /^INV\//.test(sold.sale.invoiceNo));
  eq('and priced from the database, not from what was parked', sold.sale.totalPaise, blouse.pricePaise);

  // Clean up so the 50-bill ceiling is never reached by repeated runs.
  await prisma.heldBill.deleteMany({ where: { clientId: DEV_CLIENT_ID } });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nthe suite itself broke:\n', error);
  await prisma.$disconnect();
  process.exit(1);
});
