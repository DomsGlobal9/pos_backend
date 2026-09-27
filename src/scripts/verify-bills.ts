/**
 * verify-bills -- finding a sale again, and marking reprints. Phase 1.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:bills
 *
 * The cases here are the ones a shop hits, not the ones that are easy to write:
 *
 *   - a customer comes back with a receipt and only the last four digits are readable
 *   - the owner reconciles the card machine and wants only card bills
 *   - someone scrolls a month of history while the shop is still selling into it
 *   - the same bill is printed three times and nobody can tell which copy is the original
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor, PERMISSIONS } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale, getSale } from '../services/sale';
import { list, recordPrint } from '../services/bills';
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

async function main() {
  console.log('\nverify-bills\n');

  const { counterId } = await seed();
  const items = await prisma.item.findMany({
    where: { clientId: DEV_CLIENT_ID, active: true },
    select: { id: true, code: true, pricePaise: true }
  });
  const blouse = items.find(i => i.code === 'BLO-101')!;
  const cotton = items.find(i => i.code === 'COT-010')!;
  const run = randomUUID().slice(0, 8);

  // A small, known set of sales to find again.
  const made: { invoiceNo: string; id: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await completeSale(actor, {
      onceKey: `bills-${run}-${i}`,
      counterId,
      lines: [{ itemId: i % 2 === 0 ? blouse.id : cotton.id, qty: 1 }],
      payments: [{ method: i % 3 === 0 ? 'UPI' : 'CASH', amountPaise: i % 2 === 0 ? 44900 : 129900,
                   ...(i % 3 === 0 ? { reference: `UPI${i}` } : {}) }]
    });
    made.push({ invoiceNo: r.sale.invoiceNo, id: r.sale.id });
  }

  // --------------------------------------------------------------------------------------
  console.log('finding a bill again');
  // --------------------------------------------------------------------------------------
  const newest = made[made.length - 1];

  const byFull = await list(actor, { q: newest.invoiceNo });
  ok('the whole invoice number finds it', byFull.bills.some(b => b.id === newest.id));

  // The realistic case: a creased receipt, only the tail readable.
  const tail = newest.invoiceNo.slice(-4);
  const byTail = await list(actor, { q: tail });
  ok('so does just the last four digits', byTail.bills.some(b => b.id === newest.id),
    `searched "${tail}"`);

  const nonsense = await list(actor, { q: 'zzzz-not-a-bill' });
  eq('a search that matches nothing returns nothing, not everything', nonsense.bills.length, 0);

  const wildcard = await list(actor, { q: '%' });
  eq('a bare percent sign matches nothing', wildcard.bills.length, 0);

  // --------------------------------------------------------------------------------------
  console.log('\nfiltering');
  // --------------------------------------------------------------------------------------
  const upi = await list(actor, { method: 'UPI' });
  ok('by payment method returns only bills with that method',
    upi.bills.length > 0 && upi.bills.every(b => b.methods.includes('UPI')));

  const cash = await list(actor, { method: 'CASH' });
  ok('and cash returns a different set', cash.bills.some(b => !b.methods.includes('UPI')));

  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const todays = await list(actor, { from: startOfToday });
  ok('by date returns today\'s bills', todays.bills.length >= 6);

  const tomorrow = new Date(startOfToday.getTime() + 86_400_000);
  const future = await list(actor, { from: tomorrow });
  eq('and tomorrow has none yet', future.bills.length, 0);

  const completed = await list(actor, { status: 'COMPLETED' });
  ok('by status', completed.bills.every(b => b.status === 'COMPLETED'));

  // --------------------------------------------------------------------------------------
  console.log('\nanother shop cannot see these');
  // --------------------------------------------------------------------------------------
  const other = await list({ ...actor, clientId: 'some-other-shop' }, {});
  eq('a different shop sees none of them', other.bills.length, 0);

  const otherDetail = await getSale({ ...actor, clientId: 'some-other-shop' }, newest.id)
    .then(() => 'allowed').catch(() => 'refused');
  eq('and cannot open one by id', otherDetail, 'refused');

  // --------------------------------------------------------------------------------------
  console.log('\npaging while the shop is still selling');
  // --------------------------------------------------------------------------------------
  /*
   * The trap this is written against. Keyset paging, not skip/take: a shop scrolling its history
   * is paging over a table being written to at the same time, and an offset page silently repeats
   * or skips a bill whenever a new sale lands mid-scroll. The one it skips is the one nobody
   * notices missing until a customer asks for it.
   */
  const first = await list(actor, {});
  ok('the first page is full', first.bills.length === 25, `got ${first.bills.length}`);
  ok('and offers a cursor', Boolean(first.nextCursor));

  // A sale happens between page 1 and page 2 -- exactly what breaks offset paging.
  await completeSale(actor, {
    onceKey: `bills-${run}-midscroll`,
    counterId,
    lines: [{ itemId: blouse.id, qty: 1 }],
    payments: [{ method: 'CASH', amountPaise: 44900 }]
  });

  const second = await list(actor, { after: first.nextCursor! });
  const firstIds = new Set(first.bills.map(b => b.id));
  const repeated = second.bills.filter(b => firstIds.has(b.id));
  eq('page two repeats nothing from page one, even after a sale lands mid-scroll',
    repeated.length, 0);

  const ordered = second.bills.every((b, i) =>
    i === 0 || second.bills[i - 1].createdAt >= b.createdAt);
  ok('and stays in newest-first order', ordered);

  // --------------------------------------------------------------------------------------
  console.log('\nwhat the list shows without a second query');
  // --------------------------------------------------------------------------------------
  const row = first.bills.find(b => b.id === newest.id)!;
  ok('the row carries its item count', row.itemCount >= 1);
  ok('and its payment methods', row.methods.length >= 1);
  eq('and has not been printed yet', row.printCount, 0);

  // --------------------------------------------------------------------------------------
  console.log('\nreprints are marked');
  // --------------------------------------------------------------------------------------
  const original = await recordPrint(actor, newest.id);
  eq('the first print is copy 1 -- the original', original.copyNumber, 1);

  const duplicate = await recordPrint(actor, newest.id);
  eq('the second is copy 2 -- a duplicate', duplicate.copyNumber, 2);

  const third = await recordPrint(actor, newest.id);
  eq('three presses means three copies exist, and the count says so', third.copyNumber, 3);

  const afterPrints = await getSale(actor, newest.id);
  eq('the bill remembers how many were taken', afterPrints.printCount, 3);
  ok('and when the last one was', Boolean(afterPrints.lastPrintedAt));

  const otherPrint = await recordPrint({ ...actor, clientId: 'some-other-shop' }, newest.id)
    .then(() => 'allowed').catch(() => 'refused');
  eq('another shop cannot print this bill', otherPrint, 'refused');

  // --------------------------------------------------------------------------------------
  console.log('\nthe bill reads the same as when it was made');
  // --------------------------------------------------------------------------------------
  const reread = await getSale(actor, newest.id);
  eq('same invoice number', reread.invoiceNo, newest.invoiceNo);
  ok('same tax split', reread.lines.every((l: any) =>
    l.cgstPaise + l.sgstPaise + l.igstPaise === l.taxPaise));
  ok('lines still add up to the bill',
    reread.lines.reduce((t: number, l: any) => t + l.lineTotalPaise, 0)
      + reread.roundOffPaise === reread.totalPaise);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nthe suite itself broke:\n', error);
  await prisma.$disconnect();
  process.exit(1);
});
