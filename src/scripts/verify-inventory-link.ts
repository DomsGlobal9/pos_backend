/**
 * verify-inventory-link -- the POS side of the Inventory link. Phase 8.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:inventory-link
 *
 * READ THIS FIRST. Inventory's POS endpoints do not exist yet -- the Inventory session is building
 * them to docs/product/INVENTORY-CONTRACT.md. Until they do, this suite runs a small local HTTP
 * server that answers EXACTLY as the contract says. It proves the POS's side: order, retries,
 * stopping for a person, the key handling, the catalogue mapping. It does NOT prove the two systems
 * work together. That is a separate check, run against the real Inventory once it exists.
 *
 * It uses a shop id of its own (not the till's dev shop), so nothing here touches the till's real
 * items, sales or link. Everything it makes is deleted at the end.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor, PERMISSIONS } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { connect, disconnect, retry, status, deliverNext, drain, syncCatalogue, backoffFor } from '../services/inventory-link';

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

// ------------------------------------------------------------------------------------------------
// A stand-in for Inventory, answering as INVENTORY-CONTRACT.md says. Not the real thing -- see above.
// ------------------------------------------------------------------------------------------------
const KEY = `pos_live_${randomUUID().replace(/-/g, '')}`;
const stand = {
  seen: [] as { sequence: number; eventType: string; payload: any }[],
  applied: new Set<number>(),
  answer: null as null | ((body: any) => { status: number; body: any } | null),
  catalogue: [] as any[][],
  noPosLink: false
};
function serve(port = 0): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: any) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers['x-storefront-key'] !== KEY) return send(401, { success: false, message: 'Bad key' });
      const url = new URL(req.url ?? '/', 'http://x');
      if (stand.noPosLink) return send(404, { success: false, message: 'Not found' });
      if (req.method === 'GET' && url.pathname === '/catalogue') {
        const cursor = url.searchParams.get('cursor');
        const i = cursor ? Number(cursor.replace('c', '')) : 0;
        const pages = stand.catalogue;
        const page = pages[i] ?? [];
        return send(200, { success: true, data: { products: page, hasMore: i + 1 < pages.length, nextCursor: `c${Math.min(i + 1, pages.length)}` } });
      }
      if (req.method === 'POST' && url.pathname === '/events') {
        const body = JSON.parse(raw || '{}');
        const forced = stand.answer?.(body);
        if (forced) return send(forced.status, forced.body);
        stand.seen.push(body);
        const again = stand.applied.has(body.sequence);
        stand.applied.add(body.sequence);
        return send(200, { success: true, data: { status: again ? 'ALREADY_APPLIED' : 'APPLIED' } });
      }
      send(404, { success: false, message: 'Not found' });
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main() {
  console.log('\nverify-inventory-link  (against a local stand-in for Inventory -- see the header)\n');

  const run = randomUUID().slice(0, 8);
  const clientId = `linktest-${run}`;
  const owner: Actor = { kind: 'USER', clientId, id: null, name: 'Link test owner', roles: ['OWNER'], permissions: Object.values(PERMISSIONS) };
  const cashier: Actor = { ...owner, name: 'Link test cashier', roles: ['CASHIER'], permissions: [PERMISSIONS.SELL] };

  let server = await serve();
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // An event as a real sale writes it -- copied from the till's own outbox if it has one.
  const sample = await prisma.webhookEvent.findFirst({ where: { clientId: DEV_CLIENT_ID, eventType: 'sale.completed' }, orderBy: { sequence: 'desc' } });
  const emit = (invoiceNo: string, eventType = 'sale.completed') => prisma.webhookEvent.create({
    data: { clientId, eventType, eventVersion: 1, invoiceNo, payload: { ...((sample?.payload as any) ?? {}), invoiceNo } }
  });
  const link = () => prisma.inventoryLink.findUniqueOrThrow({ where: { clientId } });
  const invoicesSeen = () => stand.seen.map(e => e.payload.invoiceNo);

  try {
    // ==========================================================================================
    console.log('connecting');
    // ==========================================================================================
    eq('a shop with no link is standalone', (await status(owner)).mode, 'STANDALONE');
    await refused('a cashier cannot connect the till', () => connect(cashier, { key: KEY, baseUrl }), /Only the owner/, 'NOT_PERMITTED');
    await refused('half a key is refused before anything is sent', () => connect(owner, { key: 'short', baseUrl }), /whole connection key/);
    await refused('a wrong key: Inventory refuses, and the owner is told what to do',
      () => connect(owner, { key: `${KEY}x`, baseUrl }), /did not accept that key/, 'KEY_REFUSED');
    await refused('an Inventory that cannot be reached is named',
      () => connect(owner, { key: KEY, baseUrl: 'http://127.0.0.1:9' }), /could not be reached at http:\/\/127\.0\.0\.1:9/, 'UNREACHABLE');
    stand.noPosLink = true;
    await refused('an Inventory without the POS link yet says so', () => connect(owner, { key: KEY, baseUrl }), /does not have the POS link yet/, 'NO_POS_LINK');
    stand.noPosLink = false;
    ok('none of the refused attempts saved anything', !(await prisma.inventoryLink.findUnique({ where: { clientId } })));

    await emit(`OLD/${run}/1`);
    await emit(`OLD/${run}/2`);
    const connected = await connect(owner, { key: KEY, baseUrl });
    eq('the right key connects', connected.mode, 'CONNECTED');
    eq('the owner sees which key, by its first characters', (connected as any).keyPrefix, KEY.slice(0, 8));
    const row = await link();
    ok('the key is stored encrypted, never as typed', !row.keyCipher.includes(KEY) && row.keyCipher.split('.').length === 3);
    ok('and never returned', !JSON.stringify(connected).includes(KEY));
    eq('sales made before connecting are NOT sent -- they were never Inventory\'s stock', (connected as any).waiting, 0);

    // ==========================================================================================
    console.log('\nsending, in order');
    // ==========================================================================================
    for (let i = 1; i <= 4; i++) await emit(`INV/${run}/${i}`);
    await prisma.webhookEvent.create({ data: { clientId, eventType: 'day.closed', eventVersion: 1, invoiceNo: null, payload: {} } });
    eq('four waiting', (await status(owner) as any).waiting, 4);
    await drain(clientId);
    eq('all four delivered, oldest first', invoicesSeen(), [1, 2, 3, 4].map(i => `INV/${run}/${i}`));
    ok('the old ones never were', !invoicesSeen().some(n => n.startsWith('OLD/')));
    ok('events that are not about stock are not sent to Inventory', !stand.seen.some(e => e.eventType === 'day.closed'));
    const seqs = stand.seen.map(e => e.sequence);
    ok('each carries its sequence, strictly rising', seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
    eq('the event goes as the outbox wrote it', stand.seen[0].payload.invoiceNo, `INV/${run}/1`);
    eq('nothing left waiting', (await status(owner) as any).waiting, 0);

    // Two server instances draining at once: every event once.
    stand.seen = [];
    for (let i = 5; i <= 14; i++) await emit(`INV/${run}/${i}`);
    await Promise.all([drain(clientId), drain(clientId), drain(clientId)]);
    await drain(clientId);
    eq('three senders at once: ten events, each sent exactly once', [stand.seen.length, new Set(invoicesSeen()).size], [10, 10]);
    ok('and still in order', invoicesSeen().every((n, i) => n === `INV/${run}/${i + 5}`), JSON.stringify(invoicesSeen()));

    // ==========================================================================================
    console.log('\nwhen Inventory is busy or down');
    // ==========================================================================================
    stand.seen = [];
    await emit(`INV/${run}/busy`);
    stand.answer = () => ({ status: 503, body: { success: false, message: 'busy' } });
    eq('Inventory busy: try again later', (await deliverNext(clientId)).outcome, 'RETRY_LATER');
    let l = await link();
    ok('after about 30 seconds', l.attempts === 1 && !!l.nextAttemptAt && Math.abs(l.nextAttemptAt.getTime() - Date.now() - 30_000) < 5_000);
    eq('in words for the owner', l.lastError, 'Inventory was busy (503).');
    eq('and not before', (await deliverNext(clientId)).outcome, 'BUSY');
    eq('the waits grow: 30 s, 2 min, 10 min, then hourly', [1, 2, 3, 4, 9].map(backoffFor), [30_000, 120_000, 600_000, 3_600_000, 3_600_000]);

    stand.answer = null;
    server.close();
    await prisma.inventoryLink.update({ where: { clientId }, data: { nextAttemptAt: null } });
    eq('Inventory down altogether: try again later too', (await deliverNext(clientId)).outcome, 'RETRY_LATER');
    ok('saying it could not be reached', /could not be reached/.test((await link()).lastError ?? ''));
    server = await serve(port);
    await prisma.inventoryLink.update({ where: { clientId }, data: { nextAttemptAt: null } });
    await drain(clientId);
    eq('back up: the same event goes, once', invoicesSeen(), [`INV/${run}/busy`]);
    eq('and the retry count is cleared', (await link()).attempts, 0);

    // ==========================================================================================
    console.log('\nwhen Inventory refuses: stop for a person');
    // ==========================================================================================
    stand.seen = [];
    await emit(`INV/${run}/bad`);
    await emit(`CN/${run}/after`, 'sale.returned');
    stand.answer = (b) => b.payload.invoiceNo === `INV/${run}/bad`
      ? { status: 422, body: { success: false, message: 'No variant GHOST-1', details: { code: 'UNKNOWN_ITEM', itemCode: 'GHOST-1' } } }
      : null;
    await drain(clientId);
    const s1 = await status(owner) as any;
    eq('the queue stops at the refused bill', s1.blocked?.document, `INV/${run}/bad`);
    eq('and says why, in words', s1.blocked?.message, 'An item on this bill (GHOST-1) is not in Inventory. Inventory said: "No variant GHOST-1"');
    eq('nothing behind it is sent -- a return of a refused sale would be wrong', stand.seen.length, 0);
    eq('the timer leaves it alone too', (await deliverNext(clientId)).outcome, 'BLOCKED');

    stand.answer = null; // the owner added the item in Inventory
    const after = await retry(owner);
    await drain(clientId);
    eq('Retry after the fix: the stopped bill, then the one behind it', invoicesSeen(), [`INV/${run}/bad`, `CN/${run}/after`]);
    eq('and the stop is cleared', (await status(owner) as any).blocked, null);
    ok('(retry answered with the status)', (after as any).mode === 'CONNECTED');

    stand.seen = [];
    await emit(`INV/${run}/key`);
    stand.answer = () => ({ status: 401, body: { success: false, message: 'Revoked' } });
    await drain(clientId);
    eq('a revoked key stops the queue and asks for a new key', (await status(owner) as any).blocked?.code, 'KEY_REFUSED');
    stand.answer = null;
    await connect(owner, { key: KEY, baseUrl });
    await drain(clientId);
    eq('connecting again with a good key clears it and sends', invoicesSeen(), [`INV/${run}/key`]);

    // ==========================================================================================
    console.log('\nnotes on bills Inventory accepted');
    // ==========================================================================================
    stand.seen = [];
    await emit(`INV/${run}/tax`);
    await emit(`INV/${run}/short`);
    await emit(`INV/${run}/plain`);
    const notes: Record<string, string[]> = {
      [`INV/${run}/tax`]: ['SILK-1: the till charged 12% GST, the product here says 5%. The bill was recorded as the till sent it.'],
      [`INV/${run}/short`]: ['SILK-2: sold 1 more than Inventory had at Counter; stock is now -1. Count it at the next stock check.']
    };
    stand.answer = (b) => notes[b.payload.invoiceNo]
      ? { status: 200, body: { success: true, data: { status: 'APPLIED', warnings: notes[b.payload.invoiceNo] } } }
      : null;
    await drain(clientId);
    stand.answer = null;
    const w = (await status(owner) as any).warnings;
    eq('a bill Inventory accepted with a note is still delivered -- nothing stops', (await status(owner) as any).waiting, 0);
    eq('the notes are kept for the owner, newest first, with the bill they are about',
      w.slice(0, 2).map((x: any) => [x.document, x.text.split(':')[0]]), [[`INV/${run}/short`, 'SILK-2'], [`INV/${run}/tax`, 'SILK-1']]);
    for (let i = 0; i < 35; i++) {
      await emit(`INV/${run}/n${i}`);
    }
    stand.answer = (b) => ({ status: 200, body: { success: true, data: { status: 'APPLIED', warnings: [`X-${b.payload.invoiceNo}: note`] } } });
    await drain(clientId);
    stand.answer = null;
    eq('only the last 30 are kept', (await status(owner) as any).warnings.length, 30);

    // ==========================================================================================
    console.log('\ndisconnecting and reconnecting');
    // ==========================================================================================
    stand.seen = [];
    await disconnect(owner);
    await emit(`INV/${run}/while-off`);
    eq('disconnected: nothing is sent', (await deliverNext(clientId)).outcome, 'NOT_CONNECTED');
    await connect(owner, { key: KEY, baseUrl });
    await drain(clientId);
    eq('reconnected: what was sold meanwhile goes -- those were Inventory\'s items', invoicesSeen(), [`INV/${run}/while-off`]);

    // ==========================================================================================
    console.log('\nthe catalogue');
    // ==========================================================================================
    const variant = (code: string, extra: any = {}) => ({
      variantCode: code, sku: code, barcode: `89${code.replace(/\D/g, '').padStart(11, '0')}`, size: 'Free', colour: 'Maroon',
      pricePaise: 1299900, hsn: '5007', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false,
      stock: { available: 3 }, ...extra
    });
    const code = (n: string) => `T${run}-${n}`;
    stand.catalogue = [
      [{ productCode: `P${run}-silk`, title: 'Kanchipuram silk saree', images: [{ url: 'https://img/x.jpg', isPrimary: true }],
         variants: [variant(code('1')), variant(code('2'), { colour: 'Green', stock: { available: 0 } })] }],
      [{ productCode: `P${run}-kurta`, title: 'Stitched kurta', images: [],
         variants: [
           variant(code('3'), { pricePaise: 320000, taxSlabbed: true, taxRateBps: 500, hsn: '6204' }),
           variant(code('4'), { taxRateBps: 250 }),
           variant(code('5'), { priceIsExclusive: true }),
           variant(code('6'), { barcode: '8901234500035' })
         ] }]
    ];
    // A barcode already on one of this shop's items, to see the clash handled.
    await prisma.item.create({ data: { clientId, code: `OWN-${run}`, name: 'Own item', pricePaise: 100, taxRate: 5, barcode: '8901234500035' } });

    await refused('a cashier cannot refresh the items', () => syncCatalogue(cashier), /manager or the owner/);
    const r1 = await syncCatalogue(owner);
    eq('the whole catalogue: five taken, one skipped', [r1.added, r1.skipped], [5, 1]);
    const silk = await prisma.item.findUniqueOrThrow({ where: { clientId_code: { clientId, code: code('1') } } });
    eq('mapped by the variant code, price in paise, rate as typed, stock as available',
      [silk.name, silk.pricePaise, silk.taxRate, silk.hsn, silk.cachedQty, silk.variantGroup, silk.imageUrl],
      ['Kanchipuram silk saree', 1299900, 5, '5007', 3, `P${run}-silk`, 'https://img/x.jpg']);
    ok('with the time the stock was read', !!silk.cachedQtyAt);
    ok('a 2.5% rate is not guessed at: skipped and named', r1.problems.some(p => p.includes(code('4')) && /not a whole percent/.test(p)));
    ok('an exclusive price is not sold, and says why', !(await prisma.item.findUniqueOrThrow({ where: { clientId_code: { clientId, code: code('5') } } })).active
      && r1.problems.some(p => p.includes(code('5')) && /priced before GST/.test(p)));
    ok('a stitched piece over Rs 2,500 at 5% is warned about, not changed',
      r1.problems.some(p => p.includes(code('3')) && /Check the rate/.test(p))
      && (await prisma.item.findUniqueOrThrow({ where: { clientId_code: { clientId, code: code('3') } } })).taxRate === 5);
    const clash = await prisma.item.findUniqueOrThrow({ where: { clientId_code: { clientId, code: code('6') } } });
    ok('a barcode already on another item is left off, and named', clash.barcode === null && r1.problems.some(p => p.includes(`OWN-${run}`)));
    eq('the problems are kept for the owner', (await status(owner) as any).catalogueProblems.length, r1.problems.length);

    // The next refresh, from the cursor: a price change, and an archived product.
    stand.catalogue = [[], [], [
      { productCode: `P${run}-silk`, title: 'Kanchipuram silk saree', images: [], variants: [variant(code('1'), { pricePaise: 1199900, stock: { available: 1 } })] },
      { productCode: `P${run}-kurta`, title: 'Stitched kurta', eligible: false, images: [], variants: [variant(code('3'))] }
    ]];
    const r2 = await syncCatalogue(owner);
    eq('the refresh picks up only what changed', [r2.added, r2.updated, r2.switchedOff], [0, 1, 1]);
    const silk2 = await prisma.item.findUniqueOrThrow({ where: { clientId_code: { clientId, code: code('1') } } });
    eq('the new price and stock', [silk2.pricePaise, silk2.cachedQty], [1199900, 1]);
    eq('an archived product stops being sold at the till', (await prisma.item.findUniqueOrThrow({ where: { clientId_code: { clientId, code: code('3') } } })).active, false);

    server.close();
    await refused('Inventory down during a refresh: the items are left as they were, and the owner is told',
      () => syncCatalogue(owner), /could not be reached.*item list is unchanged/, 'UNREACHABLE');
  } finally {
    server.close();
    await prisma.item.deleteMany({ where: { clientId } });
    await prisma.webhookEvent.deleteMany({ where: { clientId } });
    await prisma.auditLog.deleteMany({ where: { clientId } });
    await prisma.inventoryLink.deleteMany({ where: { clientId } });
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
