/**
 * verify-offline -- sales saved on a device during an outage, and sent later. Phase 11.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:offline
 *
 * Stage 1 (MASTER §16.9): the device keeps a sale it could not send and sends it again when the
 * line is back. The SERVER still gives the bill its number, when the sale arrives -- numbering
 * never happens on a device. So what is proved here is the server's half:
 *
 *   - the same sale sent twice (reply lost, flushed again) is one bill, one number, one payment
 *   - the bill and its payments are dated when the customer paid, not when the line came back --
 *     within reason: a device clock in the future, or more than a week back, is not believed
 *   - devices report how many sales they are holding, and the day close adds that up -- from
 *     devices seen in the last day only
 */

import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale, completeSaleSchema } from '../services/sale';
import { figures as dayFigures, todayString } from '../services/day-close';
import { report } from '../services/reports';
import { heartbeat, list as listDevices } from '../services/devices';
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
  try { await run(); failed++; console.error(`  FAIL  ${name}\n          it was allowed`); }
  catch (e: any) { ok(name, expect.test(e.message ?? '') && (!code || e.details?.code === code), `message: ${e.message} / ${e.details?.code}`); }
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

const close = (a: Date, b: Date, ms = 60_000) => Math.abs(a.getTime() - b.getTime()) < ms;
const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function main() {
  console.log('\nverify-offline\n');
  await seed();
  const cashier = await actorFor('dev-cashier');
  const manager = await actorFor('dev-manager');
  const run = randomUUID().slice(0, 8);
  const key = (n: string) => `off-${run}-${n}`;
  const deviceIds: string[] = [];
  const saleIds: string[] = [];

  const CTR = (await prisma.counter.findFirstOrThrow({ where: { clientId: DEV_CLIENT_ID, name: { not: { startsWith: 'zz ' } } }, orderBy: { name: 'asc' }, select: { id: true } })).id;
  const cotton = await prisma.item.findFirstOrThrow({ where: { clientId: DEV_CLIENT_ID, code: 'COT-010' }, select: { id: true } });
  const blouse = await prisma.item.findFirstOrThrow({ where: { clientId: DEV_CLIENT_ID, code: 'BLO-101' }, select: { id: true } });
  const sell = async (name: string, madeOfflineAt?: Date, itemId = blouse.id) => {
    const r = await completeSale(cashier, {
      counterId: CTR, onceKey: key(name), lines: [{ itemId, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: itemId === blouse.id ? 44900 : 129900 }],
      madeOfflineAt
    });
    saleIds.push(r.sale.id);
    return r;
  };
  const row = (id: string) => prisma.sale.findUniqueOrThrow({ where: { id }, select: { createdAt: true, madeOfflineAt: true, invoiceNo: true } });

  try {
    // ==========================================================================================
    console.log('a sale saved during an outage keeps the time it was made');
    // ==========================================================================================
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    const s1 = await sell('s1', twoHoursAgo);
    let r = await row(s1.sale.id);
    eq('POS-OFF-002 dated when the customer paid, not when it was sent', r.createdAt.toISOString(), twoHoursAgo.toISOString());
    eq('madeOfflineAt kept as the device said', r.madeOfflineAt?.toISOString(), twoHoursAgo.toISOString());
    const pays = await prisma.payment.findMany({ where: { saleId: s1.sale.id }, select: { createdAt: true } });
    ok('its payment carries the same time (cash on the same day as the bill)',
      pays.length === 1 && pays[0].createdAt.toISOString() === twoHoursAgo.toISOString(), JSON.stringify(pays));
    ok('the number is the server\'s, given on arrival', /\d/.test(s1.sale.invoiceNo) && s1.replayed === false);

    // An ordinary sale straight after takes the NEXT number -- no gap and no clash.
    const s2 = await sell('s2');
    const n1 = Number(s1.sale.invoiceNo.match(/(\d+)$/)?.[1]);
    const n2 = Number(s2.sale.invoiceNo.match(/(\d+)$/)?.[1]);
    eq('the next ordinary sale takes the next number', n2, n1 + 1);
    ok('an ordinary sale is dated now', close((await row(s2.sale.id)).createdAt, new Date()));
    eq('an ordinary sale has no madeOfflineAt', (await row(s2.sale.id)).madeOfflineAt, null);

    // ==========================================================================================
    console.log('a device clock that cannot be right is not believed');
    // ==========================================================================================
    const future = new Date(Date.now() + 3_600_000);
    const s3 = await sell('s3', future);
    r = await row(s3.sale.id);
    ok('a time in the future becomes now', close(r.createdAt, new Date()), r.createdAt.toISOString());
    eq('...and what the device said is still kept', r.madeOfflineAt?.toISOString(), future.toISOString());

    const eightDays = new Date(Date.now() - 8 * 86_400_000);
    const s4 = await sell('s4', eightDays);
    r = await row(s4.sale.id);
    ok('more than a week back becomes now', close(r.createdAt, new Date()), r.createdAt.toISOString());
    eq('...and what the device said is still kept', r.madeOfflineAt?.toISOString(), eightDays.toISOString());

    const sixDays = new Date(Date.now() - 6 * 86_400_000);
    const s5 = await sell('s5', sixDays);
    eq('six days back is believed', (await row(s5.sale.id)).createdAt.toISOString(), sixDays.toISOString());

    const bad = completeSaleSchema.safeParse({
      counterId: CTR, onceKey: key('bad'), lines: [{ itemId: blouse.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 44900 }], madeOfflineAt: 'not a date'
    });
    ok('a time that is not a time is refused before anything is written', !bad.success);

    // ==========================================================================================
    console.log('sent twice is one bill');
    // ==========================================================================================
    const before = await prisma.sale.count({ where: { clientId: DEV_CLIENT_ID, onceKey: key('s1') } });
    const again = await completeSale(cashier, {
      counterId: CTR, onceKey: key('s1'), lines: [{ itemId: blouse.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 44900 }], madeOfflineAt: twoHoursAgo
    });
    ok('the reply was lost and it was sent again: the same bill comes back', again.replayed && again.sale.id === s1.sale.id);
    eq('same number', again.sale.invoiceNo, s1.sale.invoiceNo);
    eq('still one bill for that sale', await prisma.sale.count({ where: { clientId: DEV_CLIENT_ID, onceKey: key('s1') } }), before);
    eq('still one payment', await prisma.payment.count({ where: { saleId: s1.sale.id } }), 1);

    // Sent again with a later time (the device re-stamped it): the first arrival stands.
    const later = await completeSale(cashier, {
      counterId: CTR, onceKey: key('s1'), lines: [{ itemId: blouse.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 44900 }], madeOfflineAt: new Date()
    });
    ok('a second copy with another time changes nothing', later.replayed
      && (await row(s1.sale.id)).createdAt.toISOString() === twoHoursAgo.toISOString());

    // The same key, a different basket: a stale device, not the same sale. Refused, with the number.
    await refused('the same key with a different basket is refused, naming the bill', () => completeSale(cashier, {
      counterId: CTR, onceKey: key('s1'), lines: [{ itemId: cotton.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 129900 }], madeOfflineAt: twoHoursAgo
    }), new RegExp(s1.sale.invoiceNo), 'SALE_ALREADY_COMPLETED');

    // Five copies at once -- a flaky line with the device retrying hard.
    const qtyBefore = (await prisma.item.findUniqueOrThrow({ where: { id: blouse.id }, select: { cachedQty: true } })).cachedQty ?? 0;
    const burst = await Promise.all(Array.from({ length: 5 }, () => completeSale(cashier, {
      counterId: CTR, onceKey: key('burst'), lines: [{ itemId: blouse.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 44900 }], madeOfflineAt: twoHoursAgo
    })));
    saleIds.push(burst[0].sale.id);
    eq('five copies at once: one bill', new Set(burst.map(b => b.sale.id)).size, 1);
    eq('...one of them made it, four were replays', burst.filter(b => !b.replayed).length, 1);
    eq('...one payment', await prisma.payment.count({ where: { saleId: burst[0].sale.id } }), 1);
    const qtyAfter = (await prisma.item.findUniqueOrThrow({ where: { id: blouse.id }, select: { cachedQty: true } })).cachedQty ?? 0;
    eq('...one piece off the stock count, not five', qtyBefore - qtyAfter, 1);
    eq('...one stock event for Inventory, not five', await prisma.webhookEvent.count({
      where: { clientId: DEV_CLIENT_ID, invoiceNo: burst[0].sale.invoiceNo, eventType: 'sale.completed' }
    }), 1);

    // ==========================================================================================
    console.log('a sale from yesterday lands on yesterday');
    // ==========================================================================================
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(15, 0, 0, 0);
    const yDate = dateOf(y);
    const yBefore = await dayFigures(manager, yDate);
    const tBefore = await dayFigures(manager, todayString());
    const yRep = await report(manager, { from: yDate, to: yDate }) as any;
    const s6 = await sell('s6', y, cotton.id);
    const yAfter = await dayFigures(manager, yDate);
    const tAfter = await dayFigures(manager, todayString());
    eq('yesterday\'s day close has one more bill', yAfter.bills.count - yBefore.bills.count, 1);
    eq('...and its cash', (yAfter.paidIn.CASH ?? 0) - (yBefore.paidIn.CASH ?? 0), 129900);
    eq('today\'s has none of it', tAfter.bills.count - tBefore.bills.count, 0);
    eq('...no cash either', (tAfter.paidIn.CASH ?? 0) - (tBefore.paidIn.CASH ?? 0), 0);
    const yRep2 = await report(manager, { from: yDate, to: yDate }) as any;
    eq('yesterday\'s report has it', yRep2.sales.bills - yRep.sales.bills, 1);
    ok('the bill says it was made offline', !!(await row(s6.sale.id)).madeOfflineAt);

    // ==========================================================================================
    console.log('devices say how many sales they are holding');
    // ==========================================================================================
    const dev = (n: string) => { const id = `offtest-${run}-${n}-0000000000`; deviceIds.push(id); return id; };
    const A = dev('a'), B = dev('b'), C = dev('c');
    const base = (await dayFigures(manager, todayString())).pendingSync;

    const oldest = new Date(Date.now() - 40 * 60_000).toISOString();
    const hA = await heartbeat(cashier, { deviceId: A, pending: { count: 3, oldestAt: oldest } });
    eq('the device\'s count is kept', hA.pendingCount, 3);
    eq('...and when the oldest was made', new Date(hA.pendingOldestAt!).toISOString(), oldest);
    await heartbeat(cashier, { deviceId: B, pending: { count: 2, oldestAt: oldest } });
    eq('POS-DAY-004 the day close adds up what every till is holding', (await dayFigures(manager, todayString())).pendingSync - base, 5);

    // A device quiet for more than a day is not guessed into tonight's figure.
    await heartbeat(cashier, { deviceId: C, pending: { count: 4, oldestAt: oldest } });
    await prisma.device.update({ where: { id: C }, data: { lastSeenAt: new Date(Date.now() - 25 * 3_600_000) } });
    eq('a device not seen for a day is left out', (await dayFigures(manager, todayString())).pendingSync - base, 5);
    const listed = (await listDevices(manager)).devices.find(d => d.id === C);
    eq('...but the Devices screen still shows what it holds', listed?.pendingCount, 4);

    // A plain check-in without the pending field leaves the count alone -- an old app version.
    await heartbeat(cashier, { deviceId: A });
    eq('a check-in that says nothing about pending leaves it as it was', (await listDevices(manager)).devices.find(d => d.id === A)?.pendingCount, 3);

    // Sent everything: back to nothing, and no oldest time left behind.
    const hA2 = await heartbeat(cashier, { deviceId: A, pending: { count: 0, oldestAt: oldest } });
    eq('all sent: nothing waiting', hA2.pendingCount, 0);
    eq('...and no oldest time left behind', hA2.pendingOldestAt, null);
    eq('the day close follows', (await dayFigures(manager, todayString())).pendingSync - base, 2);

    const odd = await heartbeat(cashier, { deviceId: B, pending: { count: 2.7 as any, oldestAt: null } });
    eq('a fractional count is taken down to a whole sale', odd.pendingCount, 2);
    eq('...and a count with no oldest time has none', odd.pendingOldestAt, null);
  } finally {
    await prisma.device.deleteMany({ where: { OR: [{ id: { in: deviceIds } }, { id: { startsWith: 'probe-device-' } }] } });
    // The sales stay: bills are never deleted, and the shop is the test shop.
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
