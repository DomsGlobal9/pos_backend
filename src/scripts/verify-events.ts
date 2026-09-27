/**
 * verify-events -- the stock count and the event outbox. Phase 8 (POS side).
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:events
 *
 * Two things every sale, return and exchange now does inside its own transaction:
 *
 *   - moves the POS's own count of pieces left (advisory, never blocking)
 *   - writes ONE event -- sale.completed, sale.returned or sale.exchanged -- for Inventory and, later,
 *     a shop's own software to read
 *
 * The failures this is about: a sale that rolled back but still moved stock or told someone; a
 * retried sale counted twice; an exchange reported as a return AND a sale, so a consumer moves the
 * pieces twice; two sales of the same two sarees in opposite order deadlocking; and internal uuids
 * leaking into what other systems will read.
 *
 * Uses items made for this run (switched off at the end), so the seed's counts are never relied on.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale } from '../services/sale';
import { createReturn, createExchange } from '../services/returns';
import { findOrCreate } from '../services/customers';
import { forSale } from '../services/items';
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
  catch (error: any) { ok(name, expect.test(error.message ?? ''), `message was: ${error.message}`); }
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function main() {
  console.log('\nverify-events\n');
  const { counterId } = await seed();
  const manager = await actorFor('dev-manager');
  const run = randomUUID().slice(0, 6);
  const key = (n: string) => `evt-${run}-${n}`;

  const made: string[] = [];
  const item = async (suffix: string, pricePaise: number, cachedQty: number | null) => {
    const row = await prisma.item.create({
      data: {
        clientId: DEV_CLIENT_ID, code: `EVT-${run}-${suffix}`, name: `Event test ${suffix}`,
        hsn: '5208', pricePaise, taxRate: 5, cachedQty, cachedQtyAt: new Date()
      },
      select: { id: true, code: true }
    });
    made.push(row.id);
    return row;
  };
  const qty = async (id: string) => (await prisma.item.findUniqueOrThrow({ where: { id } })).cachedQty;
  const eventsFor = (ref: string) => prisma.webhookEvent.findMany({ where: { clientId: DEV_CLIENT_ID, invoiceNo: ref }, orderBy: { sequence: 'asc' } });
  const eventCount = () => prisma.webhookEvent.count({ where: { clientId: DEV_CLIENT_ID } });

  try {
    const A = await item('A', 100000, 10);
    const B = await item('B', 50000, 10);
    const N = await item('N', 30000, null);
    const { customer } = await findOrCreate(manager, { phone: '9' + String(Date.now()).slice(-9), name: 'Events test' });

    // ==========================================================================================
    console.log('a sale');
    // ==========================================================================================
    const s1 = await completeSale(manager, {
      onceKey: key('s1'), counterId, customerId: customer.id,
      lines: [{ itemId: A.id, qty: 2 }, { itemId: N.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 230000 }]
    });
    eq('two pieces come off the count', await qty(A.id), 8);
    eq('an item with no count stays with no count', await qty(N.id), null);
    ok('and the till reads the new count', (await forSale(prisma, DEV_CLIENT_ID, [A.id])).get(A.id)?.cachedQty === 8);

    const ev1 = await eventsFor(s1.sale.invoiceNo);
    eq('exactly one event', ev1.map(e => e.eventType), ['sale.completed']);
    const p1 = ev1[0].payload as any;
    eq('carrying the bill by its public number', p1.invoiceNo, s1.sale.invoiceNo);
    eq('its lines by item code', p1.lines.map((l: any) => [l.itemCode, l.qty]).sort(), [[A.code, 2], [N.code, 1]].sort());
    eq('the totals', p1.totals.totalPaise, 230000);
    eq('the counter by name', typeof p1.counter, 'string');
    eq('the customer by phone', p1.customerRef, customer.phone);
    ok('and no internal id anywhere in it', !UUID.test(JSON.stringify(p1)), JSON.stringify(p1).match(UUID)?.[0]);
    eq('versioned', ev1[0].eventVersion, 1);

    // ==========================================================================================
    console.log('\nthe sale that did not happen, and the one pressed twice');
    // ==========================================================================================
    const before = await eventCount();
    await refused('a sale that fails',
      () => completeSale(manager, { onceKey: key('bad'), counterId, lines: [{ itemId: A.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 1 }] }),
      /still to pay/);
    eq('moves no stock', await qty(A.id), 8);
    eq('and tells nobody', await eventCount(), before);

    await completeSale(manager, {
      onceKey: key('s1'), counterId, customerId: customer.id,
      lines: [{ itemId: A.id, qty: 2 }, { itemId: N.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 230000 }]
    });
    eq('a replayed sale takes nothing off again', await qty(A.id), 8);
    eq('and writes no second event', (await eventsFor(s1.sale.invoiceNo)).length, 1);

    // ==========================================================================================
    console.log('\nselling more than the count says');
    // ==========================================================================================
    const big = await completeSale(manager, { onceKey: key('big'), counterId, lines: [{ itemId: B.id, qty: 12 }], payments: [{ method: 'CASH', amountPaise: 600000 }] });
    ok('is never blocked -- a count is a guess', !!big.sale.invoiceNo);
    eq('and the count goes below zero, which is the truth', await qty(B.id), -2);
    await prisma.item.update({ where: { id: B.id }, data: { cachedQty: 10 } });

    // ==========================================================================================
    console.log('\na kept order');
    // ==========================================================================================
    const kept = await completeSale(manager, {
      onceKey: key('kept'), counterId, kind: 'KEPT', customerId: customer.id,
      lines: [{ itemId: A.id, qty: 1 }], payments: []
    });
    eq('is sold when it is kept -- the piece is hers', await qty(A.id), 7);
    const pk = (await eventsFor(kept.sale.invoiceNo))[0].payload as any;
    eq('and the event says it is still waiting in the shop', [pk.kind, pk.fulfilment], ['KEPT', 'WAITING']);

    // ==========================================================================================
    console.log('\na return');
    // ==========================================================================================
    const r1 = await createReturn(manager, s1.sale.id, {
      onceKey: key('r1'), lines: [{ saleLineId: s1.sale.lines.find((l: any) => l.qty === 2)!.id, qty: 1 }],
      reason: 'Wrong colour', refund: { method: 'CASH' }
    });
    eq('puts the piece back on the count', await qty(A.id), 8);
    const er = await eventsFor(r1.creditNote.creditNoteNo);
    eq('writes one sale.returned', er.map(e => e.eventType), ['sale.returned']);
    const pr = er[0].payload as any;
    eq('against the original bill, by number', [pr.creditNoteNo, pr.originalInvoiceNo], [r1.creditNote.creditNoteNo, s1.sale.invoiceNo]);
    eq('with what came back', pr.lines.map((l: any) => [l.itemCode, l.qty]), [[A.code, 1]]);
    ok('no internal id in it either', !UUID.test(JSON.stringify(pr)));

    // ==========================================================================================
    console.log('\nan exchange');
    // ==========================================================================================
    const orig = await completeSale(manager, { onceKey: key('xo'), counterId, customerId: customer.id, lines: [{ itemId: A.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 100000 }] });
    eq('(sold one more)', await qty(A.id), 7);
    const beforeEx = await eventCount();
    const ex = await createExchange(manager, orig.sale.id, {
      onceKey: key('ex'), lines: [{ saleLineId: orig.sale.lines[0].id, qty: 1 }], reason: 'Wants the other one',
      newSale: { counterId, lines: [{ itemId: B.id, qty: 3 }], payments: [{ method: 'CASH', amountPaise: 50000 }] }
    });
    eq('the piece that came back is on the count again', await qty(A.id), 8);
    eq('and the three taken are off it', await qty(B.id), 7);
    eq('ONE event for the whole exchange', await eventCount(), beforeEx + 1);
    const exEvents = await eventsFor(ex.creditNote.creditNoteNo);
    eq('and it is sale.exchanged', exEvents.map(e => e.eventType), ['sale.exchanged']);
    eq('not a sale.completed for the new bill as well', (await eventsFor(ex.sale!.invoiceNo)).length, 0);
    const px = exEvents[0].payload as any;
    eq('it names all three documents', [px.originalInvoiceNo, px.creditNoteNo, px.newInvoiceNo], [orig.sale.invoiceNo, ex.creditNote.creditNoteNo, ex.sale!.invoiceNo]);
    eq('what came back and what went out', [px.returned.map((l: any) => [l.itemCode, l.qty]), px.taken.map((l: any) => [l.itemCode, l.qty])], [[[A.code, 1]], [[B.code, 3]]]);
    eq('and the difference the customer paid', px.differencePaise, 50000);
    eq('the exchange credit is not listed as a payment', px.payments.map((p: any) => p.method), ['CASH']);

    const beforeBad = await eventCount();
    await refused('an exchange that fails',
      () => createExchange(manager, s1.sale.id, {
        onceKey: key('exbad'), lines: [{ saleLineId: s1.sale.lines.find((l: any) => l.qty === 2)!.id, qty: 1 }], reason: 'Other one',
        newSale: { counterId, lines: [{ itemId: B.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 99999 }] }
      }),
      /more than|still to pay|Nothing more/);
    eq('moves nothing', [await qty(A.id), await qty(B.id)], [8, 7]);
    eq('and tells nobody', await eventCount(), beforeBad);

    // ==========================================================================================
    console.log('\ntwo tills, the same two items, opposite order');
    // ==========================================================================================
    await prisma.item.updateMany({ where: { id: { in: [A.id, B.id] } }, data: { cachedQty: 100 } });
    const both = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => completeSale(manager, {
      onceKey: key(`dl-${i}`), counterId,
      lines: i % 2 ? [{ itemId: A.id, qty: 1 }, { itemId: B.id, qty: 1 }] : [{ itemId: B.id, qty: 1 }, { itemId: A.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 150000 }]
    })));
    const rejected = both.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    eq('ten sales at once, lines in opposite orders: all ten go through, no deadlock', both.length - rejected.length, 10);
    if (rejected.length) console.error('          ', rejected[0].reason?.message);
    eq('and both counts fell by exactly ten', [await qty(A.id), await qty(B.id)], [90, 90]);

    const seqs = (await prisma.webhookEvent.findMany({ where: { clientId: DEV_CLIENT_ID, invoiceNo: { in: (both.filter(r => r.status === 'fulfilled') as any[]).map(r => r.value.sale.invoiceNo) } }, select: { sequence: true } }))
      .map(e => Number(e.sequence));
    eq('ten events, each with its own sequence number', new Set(seqs).size, 10);
  } finally {
    await prisma.item.updateMany({ where: { id: { in: made } }, data: { active: false } });
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
