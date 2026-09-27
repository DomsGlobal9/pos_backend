/**
 * verify-sale -- the sell path, against a real database.
 *
 *     node src/scripts/local-db.mjs start        (in another terminal)
 *     npm --prefix D:\villy\pos\backend run verify:sale
 *
 * Real Postgres, real transactions, real unique constraints, real row locks. Nothing about the
 * thing being tested is stubbed: only the cashier's identity is, and only until sign-in exists.
 *
 * The cases here are the ones invented against this code rather than the happy path written
 * backwards. The four that matter most:
 *
 *   - the same bill submitted twice, which happens every time a cashier presses Complete on a slow
 *     connection
 *   - the same key with a different basket, which is a stale screen and must never charge anyone
 *   - two tills completing at the same instant, which is a Saturday
 *   - a price sent by the browser, which must be impossible rather than merely discouraged
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor, PERMISSIONS } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale, getSale } from '../services/sale';
import { search } from '../services/items';
import { seed } from './seed-dev';

const actor: Actor = {
  kind: 'USER', clientId: DEV_CLIENT_ID, id: 'dev-cashier', name: 'Dev cashier',
  roles: ['OWNER'], permissions: Object.values(PERMISSIONS)
};

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
  console.log('\nverify-sale\n');

  const { counterId } = await seed();
  const items = await prisma.item.findMany({
    where: { clientId: DEV_CLIENT_ID },
    select: { id: true, code: true, pricePaise: true, taxRate: true, active: true }
  });
  const byCode = new Map(items.map(i => [i.code, i]));
  const kanchi = byCode.get('KAN-001')!;   // 12,999.00 at 12%
  const cotton = byCode.get('COT-010')!;   //  1,299.00 at 5%
  const blouse = byCode.get('BLO-101')!;   //    449.00 at 5%
  const retired = byCode.get('RET-900')!;

  // Every sale in this run is tagged, so the series assertions can count only its own.
  const run = randomUUID().slice(0, 8);
  const key = (name: string) => `verify-${run}-${name}`;

  // ------------------------------------------------------------------------------------------
  console.log('finding something to sell');
  // ------------------------------------------------------------------------------------------
  const scanned = await search(actor, '8901234500019');
  ok('a scanned barcode is answered on its own', scanned.exact && scanned.items.length === 1);
  eq('and it is the right item', scanned.items[0]?.code, 'KAN-001');

  /*
   * Changed in Phase 2, deliberately: three colours of one saree now collapse to a single row with
   * a picker behind it (POS-SELL-006). The old expectation here was two separate rows, which is the
   * behaviour that made a search for "kanchipuram" unreadable. Covered in depth by verify-variants.
   */
  const byName = await search(actor, 'kanchipuram');
  ok('colours of one saree collapse to a single row', byName.items.length === 1 && !byName.exact,
    `got ${byName.items.length} rows`);
  ok('which says how many colours are behind it', byName.items[0]?.variantCount === 3);

  const narrowed = await search(actor, 'kanchipuram maroon');
  ok('every word must match, so two words narrow to one', narrowed.items.length === 1,
    `got ${narrowed.items.length}`);

  const wildcard = await search(actor, '%');
  ok('a bare percent sign matches nothing, rather than the whole shop', wildcard.items.length === 0,
    `got ${wildcard.items.length} items`);

  const underscore = await search(actor, '_');
  ok('so does a bare underscore', underscore.items.length === 0);

  const retiredSearch = await search(actor, 'georgette');
  ok('a retired item is not offered for sale', retiredSearch.items.length === 0);

  const lastOne = (await search(actor, 'KAN-002')).items[0];
  eq('the screen can honestly say how many are left', lastOne?.availableQty, 1);

  // ------------------------------------------------------------------------------------------
  console.log('\na plain cash sale');
  // ------------------------------------------------------------------------------------------
  const first = await completeSale(actor, {
    onceKey: key('plain'),
    counterId,
    lines: [{ itemId: cotton.id, qty: 2 }, { itemId: blouse.id, qty: 1 }],
    payments: [{ method: 'CASH', amountPaise: 304700, tenderedPaise: 400000 }]
  });

  // 1,299.00 x 2 = 2,598.00 ; 449.00 x 1 = 449.00 ; total 3,047.00, already whole rupees.
  eq('the bill adds up', first.sale.totalPaise, 304700);
  eq('nothing was discounted', first.sale.discountPaise, 0);
  eq('and nothing needed rounding', first.sale.roundOffPaise, 0);
  ok('it was not a replay', first.replayed === false);
  ok('it has an invoice number', /^INV\/\d{4}-\d{2}\/\d{4}$/.test(first.sale.invoiceNo),
    first.sale.invoiceNo);
  eq('both lines were written', first.sale.lines.length, 2);

  const lineTax = first.sale.lines.reduce((sum: number, l: any) => sum + l.taxPaise, 0);
  eq('the bill tax is the sum of its lines', first.sale.taxPaise, lineTax);

  const netPlusTax = first.sale.lines.reduce(
    (sum: number, l: any) => sum + l.lineTotalPaise, 0);
  eq('the lines add up to the bill', netPlusTax, first.sale.totalPaise);

  // 5% inclusive on 2,598.00 -> net 2,474.29, tax 123.71
  const cottonLine = first.sale.lines.find((l: any) => l.taxRate === 5 && l.qty === 2);
  eq('GST is taken back out of the shelf price', cottonLine?.taxPaise, 12371);

  const payment = first.sale.payments[0];
  eq('change is worked out, not guessed', payment?.changePaise, 95300);
  eq('and what was handed over is kept', payment?.tenderedPaise, 400000);

  // ------------------------------------------------------------------------------------------
  console.log('\nthe tax split is stored, not worked out again');

  const splitSum = first.sale.lines.reduce(
    (t: number, l: any) => t + l.cgstPaise + l.sgstPaise + l.igstPaise, 0);
  eq('CGST + SGST + IGST is exactly the bill tax', splitSum, first.sale.taxPaise);
  for (const line of first.sale.lines) {
    eq(`a line's halves add up to its own tax (HSN ${line.hsn})`,
      line.cgstPaise + line.sgstPaise + line.igstPaise, line.taxPaise);
  }
  ok('an intra-state bill carries no IGST',
    first.sale.lines.every((l: any) => l.igstPaise === 0));

  const interStateSale = await completeSale(actor, {
    onceKey: key('interstate'), counterId,
    lines: [{ itemId: cotton.id, qty: 1 }],
    payments: [{ method: 'CASH', amountPaise: 129900 }],
    interState: true
  });
  ok('a bill to another state is all IGST, with no CGST/SGST pair',
    interStateSale.sale.lines.every((l: any) =>
      l.igstPaise === l.taxPaise && l.cgstPaise === 0 && l.sgstPaise === 0));

  // The whole reason the split is stored rather than recomputed: a reprint must say what the
  // counter said -- in five years, from a newer build, whatever the odd-paisa rule does between.
  const reprinted = await getSale(actor, first.sale.id);
  eq('a reprint shows the same split as the original',
    reprinted.lines.map((l: any) => [l.cgstPaise, l.sgstPaise, l.igstPaise]),
    first.sale.lines.map((l: any) => [l.cgstPaise, l.sgstPaise, l.igstPaise]));
  eq('and the same total', reprinted.totalPaise, first.sale.totalPaise);

  console.log('\nthe same bill twice');
  // ------------------------------------------------------------------------------------------
  const again = await completeSale(actor, {
    onceKey: key('plain'),
    counterId,
    lines: [{ itemId: cotton.id, qty: 2 }, { itemId: blouse.id, qty: 1 }],
    payments: [{ method: 'CASH', amountPaise: 304700, tenderedPaise: 400000 }]
  });
  ok('the second press is a replay', again.replayed === true);
  eq('and gets the first bill back', again.sale.invoiceNo, first.sale.invoiceNo);

  const countForKey = await prisma.sale.count({
    where: { clientId: DEV_CLIENT_ID, onceKey: key('plain') }
  });
  eq('there is exactly one sale for that key', countForKey, 1);

  await refused('the same key with a different basket is refused',
    () => completeSale(actor, {
      onceKey: key('plain'),
      counterId,
      lines: [{ itemId: kanchi.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 1299900 }]
    }),
    /already completed/i);

  // ------------------------------------------------------------------------------------------
  console.log('\ntwo tills at the same instant');
  // ------------------------------------------------------------------------------------------
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, i) => completeSale(actor, {
      onceKey: key(`race-${i}`),
      counterId,
      lines: [{ itemId: blouse.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 44900 }]
    }))
  );
  const numbers = concurrent.map(r => r.sale.invoiceNo);
  eq('eight sales got eight different numbers', new Set(numbers).size, 8);

  const sequences = numbers.map(n => Number(n.split('/').pop())).sort((a, b) => a - b);
  const gaps = sequences.filter((n, i) => i > 0 && n !== sequences[i - 1] + 1);
  eq('and the series has no gaps in them', gaps.length, 0);

  // ------------------------------------------------------------------------------------------
  console.log('\nthings that must be refused');
  // ------------------------------------------------------------------------------------------
  /*
   * The message changed in Phase 2 and is better for it: it now names the SHORTFALL rather than
   * restating both figures and leaving the cashier to subtract them with a queue waiting.
   */
  await refused('a payment that does not match the bill, naming what is missing',
    () => completeSale(actor, {
      onceKey: key('mismatch'), counterId,
      lines: [{ itemId: cotton.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 100000 }]
    }),
    /₹299 still to pay on a ₹1,299 bill/);

  await refused('less cash handed over than the payment claims',
    () => completeSale(actor, {
      onceKey: key('short'), counterId,
      lines: [{ itemId: cotton.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 129900, tenderedPaise: 100000 }]
    }),
    /was handed over/i);

  await refused('an item the shop has retired',
    () => completeSale(actor, {
      onceKey: key('retired'), counterId,
      lines: [{ itemId: retired.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 99900 }]
    }),
    /no longer sold/i);

  await refused('an item that does not exist at all',
    () => completeSale(actor, {
      onceKey: key('ghost'), counterId,
      lines: [{ itemId: randomUUID(), qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 100 }]
    }),
    /no longer in the item list/i);

  const before = await prisma.sale.count({ where: { clientId: DEV_CLIENT_ID } });
  await refused('an item belonging to another shop',
    () => completeSale({ ...actor, clientId: 'some-other-shop' }, {
      onceKey: key('tenant'), counterId,
      lines: [{ itemId: cotton.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 129900 }]
    }),
    /no longer in the item list/i);
  eq('and no sale was written for it', await prisma.sale.count({ where: { clientId: DEV_CLIENT_ID } }), before);

  // ------------------------------------------------------------------------------------------
  console.log('\na refused sale leaves nothing behind');
  // ------------------------------------------------------------------------------------------
  const seriesBefore = await prisma.invoiceSeries.findFirst({
    where: { clientId: DEV_CLIENT_ID, kind: 'INVOICE' }, select: { lastNumber: true }
  });
  await refused('a sale that fails on its payment',
    () => completeSale(actor, {
      onceKey: key('rollback'), counterId,
      lines: [{ itemId: kanchi.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 1 }]
    }),
    /still to pay/i);
  const seriesAfter = await prisma.invoiceSeries.findFirst({
    where: { clientId: DEV_CLIENT_ID, kind: 'INVOICE' }, select: { lastNumber: true }
  });
  eq('burns no invoice number', seriesAfter?.lastNumber, seriesBefore?.lastNumber);

  // ------------------------------------------------------------------------------------------
  console.log('\na bill discount, spread across the lines');
  // ------------------------------------------------------------------------------------------
  const discounted = await completeSale(actor, {
    onceKey: key('discount'), counterId,
    lines: [{ itemId: cotton.id, qty: 1 }, { itemId: blouse.id, qty: 1 }, { itemId: blouse.id, qty: 1 }],
    payments: [{ method: 'CASH', amountPaise: 199700 }],
    billDiscountPaise: 20000
  });
  eq('the discount is recorded whole', discounted.sale.discountPaise, 20000);
  const spread = discounted.sale.lines.reduce((s: number, l: any) => s + l.discountPaise, 0);
  eq('and the parts add back up to it exactly', spread, 20000);
  const discountedTotal = discounted.sale.lines.reduce((s: number, l: any) => s + l.lineTotalPaise, 0);
  eq('the discounted lines still add up to the bill', discountedTotal, discounted.sale.totalPaise);
  const discountedTax = discounted.sale.lines.reduce((s: number, l: any) => s + l.taxPaise, 0);
  eq('and the tax was worked out AFTER the discount', discounted.sale.taxPaise, discountedTax);
  ok('which is less tax than before it',
    discountedTax < Math.round((129900 + 44900 * 2) * 5 / 105),
    `tax was ${discountedTax}`);

  // ------------------------------------------------------------------------------------------
  console.log('\nrounding');
  // ------------------------------------------------------------------------------------------
  // 1,299.00 at 5% plus 449.00 x 3 = 2,646.00. Whole rupees. Use a discount to make it awkward.
  const odd = await completeSale(actor, {
    onceKey: key('rounding'), counterId,
    lines: [{ itemId: cotton.id, qty: 1 }],
    payments: [{ method: 'CASH', amountPaise: 119900 }],
    billDiscountPaise: 10033
  });
  eq('an awkward total is rounded to whole rupees', odd.sale.totalPaise % 100, 0);
  ok('and the adjustment is recorded, not absorbed', odd.sale.roundOffPaise !== 0,
    `round-off was ${odd.sale.roundOffPaise}`);
  const oddLines = odd.sale.lines.reduce((s: number, l: any) => s + l.lineTotalPaise, 0);
  eq('charged = lines + round-off', oddLines + odd.sale.roundOffPaise, odd.sale.totalPaise);

  // ------------------------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nthe suite itself broke:\n', error);
  await prisma.$disconnect();
  process.exit(1);
});
