/**
 * verify-customers -- the phone number is the identity, so getting it wrong splits a person in two.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:customers
 *
 * The failure this file is written against is quiet and permanent: a cashier types the same number
 * a different way, a second customer record appears, and from then on that person has two visit
 * counts, two lifetime spends and a loyalty balance split across both. Nobody notices until the
 * customer says "I have shopped here for years" and the screen says it is their first visit.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor, PERMISSIONS } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { normalisePhone, displayPhone, maskPhone, sameNumber } from '../utils/phone';
import { findByPhone, findOrCreate, search, detail } from '../services/customers';
import { completeSale } from '../services/sale';
import { seed } from './seed-dev';

const actor: Actor = {
  kind: 'USER', clientId: DEV_CLIENT_ID, id: 'dev-cashier', name: 'Dev cashier',
  roles: ['OWNER'], permissions: Object.values(PERMISSIONS)
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
  console.log('\nverify-customers\n');
  const { counterId } = await seed();
  const item = await prisma.item.findFirst({
    where: { clientId: DEV_CLIENT_ID, code: 'BLO-101' }, select: { id: true, pricePaise: true }
  });
  const run = randomUUID().slice(0, 6);

  // A number nobody else in this database has.
  const digits = '9' + String(Date.now()).slice(-9);
  const e164 = '+91' + digits;

  // ==========================================================================================
  console.log('one person, however they write their number');
  // ==========================================================================================
  eq('ten digits', normalisePhone(digits).e164, e164);
  eq('with spaces', normalisePhone(`${digits.slice(0, 5)} ${digits.slice(5)}`).e164, e164);
  eq('with a country code', normalisePhone(`+91 ${digits}`).e164, e164);
  eq('with a leading zero', normalisePhone(`0${digits}`).e164, e164);
  eq('with 091', normalisePhone(`091${digits}`).e164, e164);
  eq('with dashes and brackets', normalisePhone(`(0${digits.slice(0, 3)}) ${digits.slice(3)}`).e164, e164);
  eq('already normalised', normalisePhone(e164).e164, e164);

  ok('so all of those are the same person',
    sameNumber(digits, `+91 ${digits}`) && sameNumber(`0${digits}`, e164));

  eq('a foreign number keeps its own country code',
    normalisePhone('+44 7700 900123').e164, '+447700900123');

  // ==========================================================================================
  console.log('\nand a number that cannot be saved is refused, not guessed');
  // ==========================================================================================
  refused('nothing typed', () => normalisePhone(''), /Enter a phone number/);
  refused('too short', () => normalisePhone('12345'), /10-digit mobile number/);
  refused('ten digits starting with 5', () => normalisePhone('5123456789'),
    /starts with 6, 7, 8 or 9/);
  refused('letters', () => normalisePhone('not a number'), /does not look like a phone number/);
  refused('far too long', () => normalisePhone('+1234567890123456789'),
    /does not look like a phone number/);

  // ==========================================================================================
  console.log('\nwhat a person reads, and what a receipt may show');
  // ==========================================================================================
  eq('grouped the way an Indian number is read',
    displayPhone('+919876543210'), '+91 98765 43210');
  eq('a foreign number is left alone rather than grouped wrongly',
    displayPhone('+447700900123'), '+447700900123');
  eq('a receipt shows only the last four', maskPhone('+919876543210'), '••••3210');
  ok('which is enough to recognise and not enough to call',
    !maskPhone('+919876543210').includes('98765'));

  // ==========================================================================================
  console.log('\nadding someone at the counter');
  // ==========================================================================================
  const first = await findOrCreate(actor, { phone: digits, name: 'Priya' });
  ok('a new customer is created', first.created === true);
  eq('stored in one canonical form', first.customer.phone, e164);
  eq('and shown the way it is read', first.customer.phoneDisplay, displayPhone(e164));
  eq('with no visits yet', first.customer.visitCount, 0);
  eq('and no consent unless it was asked for', first.customer.marketingConsent, false);

  const again = await findOrCreate(actor, { phone: `+91 ${digits}`, name: 'Priya' });
  ok('the same number written differently finds them', again.created === false);
  eq('and it is the same record', again.customer.id, first.customer.id);

  const count = await prisma.customer.count({ where: { clientId: DEV_CLIENT_ID, phone: e164 } });
  eq('so there is exactly one of them', count, 1);

  // ==========================================================================================
  console.log('\ntwo cashiers, same number, same moment');
  // ==========================================================================================
  const raceDigits = '9' + String(Date.now() + 1).slice(-9);
  const racers = await Promise.all(
    Array.from({ length: 5 }, () => findOrCreate(actor, { phone: raceDigits, name: 'Race' }))
  );
  eq('five attempts make one customer', new Set(racers.map(r => r.customer.id)).size, 1);
  eq('and the database agrees',
    await prisma.customer.count({ where: { clientId: DEV_CLIENT_ID, phone: '+91' + raceDigits } }), 1);

  // ==========================================================================================
  console.log('\nwhat a second visit may and may not change');
  // ==========================================================================================
  const noName = await findOrCreate(actor, { phone: '9' + String(Date.now() + 2).slice(-9) });
  eq('someone can be added with no name at all', noName.customer.name, null);

  const named = await findOrCreate(actor, { phone: noName.customer.phone, name: 'Anjali Raman' });
  eq('and named later', named.customer.name, 'Anjali Raman');

  const renamed = await findOrCreate(actor, { phone: noName.customer.phone, name: 'A' });
  eq('but a hurried retype does not overwrite the full name', renamed.customer.name, 'Anjali Raman');

  // ==========================================================================================
  console.log('\nconsent only ever goes on');
  // ==========================================================================================
  eq('starts off', renamed.customer.marketingConsent, false);

  const consented = await findOrCreate(actor, {
    phone: noName.customer.phone, marketingConsent: true
  });
  eq('the cashier ticks it, and it is recorded', consented.customer.marketingConsent, true);

  const withRecord = await prisma.customer.findFirst({
    where: { id: consented.customer.id }, select: { consentAt: true }
  });
  ok('with the moment it was given', Boolean(withRecord?.consentAt));

  /*
   * A counter screen WITHOUT the tick is not the customer saying no -- it is usually nobody
   * having asked. So a later sale that does not mention consent must not silently withdraw it.
   */
  const laterSale = await findOrCreate(actor, { phone: noName.customer.phone, name: 'A' });
  eq('and a later sale with the box unticked does NOT withdraw it',
    laterSale.customer.marketingConsent, true);

  // ==========================================================================================
  console.log('\nvisits and lifetime spend');
  // ==========================================================================================
  for (let i = 0; i < 3; i++) {
    await completeSale(actor, {
      onceKey: `cust-${run}-${i}`,
      counterId,
      customerId: first.customer.id,
      lines: [{ itemId: item!.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: item!.pricePaise }]
    });
  }

  const afterThree = await findByPhone(actor, digits);
  eq('three sales is three visits', afterThree?.visitCount, 3);
  eq('and their lifetime spend adds up', afterThree?.lifetimeSpentPaise, item!.pricePaise * 3);
  ok('with a first and last seen date', Boolean(afterThree?.firstSeenAt && afterThree?.lastSeenAt));

  const card = await detail(actor, first.customer.id);
  eq('the detail shows their recent bills', card.recent.length, 3);
  ok('newest first', card.recent[0].createdAt >= card.recent[2].createdAt);

  // ==========================================================================================
  console.log('\nfinding them again');
  // ==========================================================================================
  const byName = await search(actor, 'Priya');
  ok('by name', byName.some(c => c.id === first.customer.id));

  const byPartial = await search(actor, digits.slice(-6));
  ok('by the last six digits of their number', byPartial.some(c => c.id === first.customer.id));

  const bySpaced = await search(actor, `${digits.slice(0, 5)} ${digits.slice(5)}`);
  ok('by a number typed with a space in it', bySpaced.some(c => c.id === first.customer.id));

  const nobody = await search(actor, 'zzzz-nobody');
  eq('and a search matching nobody returns nobody', nobody.length, 0);

  const missing = await findByPhone(actor, '9' + String(Date.now() + 9).slice(-9));
  eq('an unknown number is null, not an error -- we simply have not met them', missing, null);

  // ==========================================================================================
  console.log('\nanother shop');
  // ==========================================================================================
  const otherShop = { ...actor, clientId: 'some-other-shop' };
  eq('cannot find them by number', await findByPhone(otherShop, digits), null);
  eq('nor by search', (await search(otherShop, 'Priya')).length, 0);
  await refusedAsync('nor open them by id',
    () => detail(otherShop, first.customer.id), /not found/i);

  /*
   * The same number in two different shops is two different customers. A person who shops at two
   * saree shops is not one record shared between them.
   */
  const elsewhere = await findOrCreate(otherShop, { phone: digits, name: 'Someone else' });
  ok('and the same number there is a different person', elsewhere.customer.id !== first.customer.id);
  eq('with their own visit count', elsewhere.customer.visitCount, 0);

  // ==========================================================================================
  console.log('\nthe sale');
  // ==========================================================================================
  const withCustomer = await completeSale(actor, {
    onceKey: `cust-${run}-linked`,
    counterId,
    customerId: first.customer.id,
    lines: [{ itemId: item!.id, qty: 1 }],
    payments: [{ method: 'CASH', amountPaise: item!.pricePaise }]
  });
  eq('a sale can carry a customer', withCustomer.sale.customer?.id, first.customer.id);
  eq('and the receipt masks their number', withCustomer.sale.customer?.phoneMasked, maskPhone(e164));

  const anonymous = await completeSale(actor, {
    onceKey: `cust-${run}-anon`,
    counterId,
    lines: [{ itemId: item!.id, qty: 1 }],
    payments: [{ method: 'CASH', amountPaise: item!.pricePaise }]
  });
  eq('and a sale with NO customer still works -- this must never break',
    anonymous.sale.customer, null);

  await refusedAsync('a sale cannot borrow another shop\'s customer',
    () => completeSale(actor, {
      onceKey: `cust-${run}-tenant`,
      counterId,
      customerId: elsewhere.customer.id,
      lines: [{ itemId: item!.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: item!.pricePaise }]
    }),
    /customer was not found/i);

  await refusedAsync('nor one that does not exist',
    () => completeSale(actor, {
      onceKey: `cust-${run}-ghost`,
      counterId,
      customerId: randomUUID(),
      lines: [{ itemId: item!.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: item!.pricePaise }]
    }),
    /customer was not found/i);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nthe suite itself broke:\n', error);
  await prisma.$disconnect();
  process.exit(1);
});
