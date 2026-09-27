/**
 * verify-receipts -- digital receipts, WhatsApp sending, the UPI QR setting, devices. Phase 10.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:receipts
 *
 * THE PHASE 10 GATE: "async receipt failures cannot damage the sale". Every failure path here --
 * WhatsApp not set up, the person replied STOP, the service down -- is followed by a check that the
 * bill is byte-for-byte what it was.
 *
 * The PDF is read back with a real PDF reader (Python's pypdf), not by looking at bytes: a PDF that
 * our own code thinks is fine but a phone cannot open is the failure worth catching.
 *
 * WhatsApp is ScaleEzy's own service, which needs a module key the POS does not have yet, so this
 * runs a local stand-in that answers as that service's README documents (202 + id, duplicate on a
 * repeated idempotencyKey, 422 with a plain-English error for STOP). The same approach the
 * Inventory module uses for its WhatsApp tests. It proves the POS side, not the real delivery.
 */

import http from 'http';
import { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale, getSale } from '../services/sale';
import { findOrCreate } from '../services/customers';
import { receiptLink, pdfFor, publicReceipt, publicPdf, money, ascii } from '../services/receipts';
import { sendReceipt, sendsFor } from '../services/receipt-send';
import { setUpiId, forTill } from '../services/shop';
import { heartbeat, list as listDevices, update as updateDevice } from '../services/devices';
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Read a PDF with pypdf: page size and text. */
function readPdf(buf: Buffer) {
  const file = path.join(os.tmpdir(), `pos-receipt-${randomUUID()}.pdf`);
  fs.writeFileSync(file, buf);
  try {
    const out = execFileSync('python', ['-c', [
      'import sys, json',
      'from pypdf import PdfReader',
      'r = PdfReader(sys.argv[1], strict=True)',
      'p = r.pages[0]',
      'print(json.dumps({"pages": len(r.pages), "w": float(p.mediabox.width), "h": float(p.mediabox.height), "text": p.extract_text()}))'
    ].join('\n'), file], { encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    fs.unlinkSync(file);
  }
}

// ------------------------------------------------------------------------------------------------
// A stand-in for ScaleEzy's WhatsApp service, answering as its README documents.
// ------------------------------------------------------------------------------------------------
const MODULE_KEY = `pos-test-${randomUUID()}`;
const wa = {
  seen: [] as { headers: http.IncomingHttpHeaders; body: any }[],
  keys: new Map<string, string>(),
  stop: new Set<string>()
};
function serveWhatsApp(port = 0): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: any) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers['x-module-key'] !== MODULE_KEY) return send(401, { error: { code: 'UNAUTHORISED', message: 'That module key is not right.' } });
      if (req.method === 'POST' && req.url === '/v1/messages') {
        const body = JSON.parse(raw || '{}');
        if (wa.stop.has(body.to)) return send(422, { error: { code: 'OPTED_OUT', message: 'This person replied STOP, so the shop cannot message them.' } });
        const dup = wa.keys.get(body.idempotencyKey);
        if (dup) return send(202, { id: dup, status: 'QUEUED', duplicate: true });
        const id = randomUUID();
        wa.keys.set(body.idempotencyKey, id);
        wa.seen.push({ headers: req.headers, body });
        return send(202, { id, status: 'QUEUED' });
      }
      const m = /^\/v1\/messages\/([\w-]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && m) return send(200, { id: m[1], status: 'DELIVERED' });
      send(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main() {
  console.log('\nverify-receipts\n');
  const { counterId } = await seed();
  const cashier = await actorFor('dev-cashier');
  const manager = await actorFor('dev-manager');
  const owner = await actorFor('dev-owner');
  const run = randomUUID().slice(0, 8);
  const key = (n: string) => `rcp-${run}-${n}`;
  const item = (code: string) => prisma.item.findFirstOrThrow({ where: { clientId: DEV_CLIENT_ID, code }, select: { id: true } });
  const cotton = await item('COT-010');
  const { customer } = await findOrCreate(cashier, { phone: '9' + String(Date.now()).slice(-9), name: 'Receipt test' });

  const savedEnv = { url: process.env.WHATSAPP_SERVICE_URL, key: process.env.WHATSAPP_MODULE_KEY };
  const savedUpi = (await prisma.shopSettings.findUniqueOrThrow({ where: { clientId: DEV_CLIENT_ID } })).upiId;
  let server: http.Server | null = null;

  try {
    // ==========================================================================================
    console.log('the digital receipt link');
    // ==========================================================================================
    const s1 = await completeSale(cashier, {
      onceKey: key('s1'), counterId, customerId: customer.id, lines: [{ itemId: cotton.id, qty: 1 }],
      payments: [{ method: 'CASH', amountPaise: 129900, tenderedPaise: 150000 }]
    });
    ok('every new bill has its own link', /\/r\/[A-Za-z0-9_-]{24}$/.test(s1.sale.receiptUrl ?? ''), s1.sale.receiptUrl ?? 'none');
    const token = s1.sale.receiptUrl!.split('/r/')[1];

    await prisma.sale.update({ where: { id: s1.sale.id }, data: { receiptToken: null } });
    const l1 = await receiptLink(cashier, s1.sale.id);
    const l2 = await receiptLink(cashier, s1.sale.id);
    ok('a bill from before digital receipts gets a link when asked, and keeps it', l1.token === l2.token && l1.token !== token && l1.token.length === 24);
    const t = l1.token;

    const pub: any = await publicReceipt(t);
    eq('the public receipt is that bill', [pub.invoiceNo, pub.totalPaise], [s1.sale.invoiceNo, 129900]);
    ok('with the customer\'s number masked', pub.customer?.phoneMasked?.startsWith('••••') && !JSON.stringify(pub).includes(customer.phone));
    ok('and none of our internal ids anywhere in it', !UUID.test(JSON.stringify(pub)), JSON.stringify(pub).match(UUID)?.[0]);
    await refused('a made-up link finds nothing', () => publicReceipt('A'.repeat(24)), /not right/);
    await refused('a malformed one says the same, and nothing more', () => publicReceipt('../../etc'), /not right/);

    // ==========================================================================================
    console.log('\nthe PDF, read back with a real PDF reader');
    // ==========================================================================================
    const { pdf } = await pdfFor(cashier, s1.sale.id);
    ok('it is a PDF', pdf.subarray(0, 8).toString('latin1') === '%PDF-1.4');
    const doc = readPdf(pdf);
    eq('one page', doc.pages, 1);
    ok('80 mm wide', Math.abs(doc.w - 226.77) < 0.5, String(doc.w));
    ok('as long as the bill, no longer', doc.h > 250 && doc.h < 900, String(doc.h));
    for (const want of [s1.sale.invoiceNo, 'TOTAL', 'Rs 1,299', 'CGST', 'SGST', 'HSN 5208', 'Cash', 'Change', 'Rs 201', 'Lakshmi Silks', `/r/${t}`]) {
      // Read across line breaks: an address longer than the paper is wide wraps (the QR carries it whole).
      ok(`it says "${want}"`, doc.text.includes(want) || doc.text.replace(/\n/g, '').includes(want), doc.text.slice(0, 200));
    }
    ok('the number is masked on the PDF too', !doc.text.includes(customer.phone.slice(-10)) && doc.text.includes(customer.phone.slice(-4)));
    ok('the QR code is drawn into it', (pdf.toString('latin1').match(/ re /g) ?? []).length > 150);
    const fromLink = await publicPdf(t);
    ok('the public link gives the same document', fromLink.pdf.equals(pdf));

    const kept = await completeSale(manager, {
      onceKey: key('kept'), counterId, kind: 'KEPT', customerId: customer.id, note: 'Fall and pico (both sides)',
      lines: [{ itemId: cotton.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 50000 }]
    });
    const keptDoc = readPdf((await pdfFor(manager, kept.sale.id)).pdf);
    ok('a kept order\'s PDF is also its claim ticket', keptDoc.text.includes('KEPT FOR COLLECTION') && keptDoc.text.includes('Balance due') && keptDoc.text.includes('Rs 799'));
    ok('brackets in a note do not break the PDF', keptDoc.text.includes('Fall and pico (both sides)'));

    eq('money in Indian grouping, no rupee sign the built-in fonts lack', [money(1299900), money(12345678), money(-4050), money(0)], ['Rs 12,999', 'Rs 1,23,456.78', '-Rs 40.50', 'Rs 0']);
    eq('anything a built-in font cannot draw becomes plain text', ascii('₹1,299 · ••••3210 — ok'), 'Rs 1,299 - ****3210 - ok');

    // ==========================================================================================
    console.log('\nWhatsApp: the failures first -- none may touch the bill');
    // ==========================================================================================
    const before = JSON.stringify(await getSale(cashier, s1.sale.id));
    const same = async () => JSON.stringify(await getSale(cashier, s1.sale.id)) === before;

    delete process.env.WHATSAPP_SERVICE_URL;
    delete process.env.WHATSAPP_MODULE_KEY;
    await refused('not set up: said plainly, with what to do instead',
      () => sendReceipt(cashier, s1.sale.id, { onceKey: key('w0') }), /not set up for this till yet\. Print the bill, or show the QR code/, 'NOT_CONFIGURED');
    const walkin = await completeSale(cashier, { onceKey: key('walkin'), counterId, lines: [{ itemId: cotton.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 129900 }] });
    await refused('a bill with no customer has no number to send to', () => sendReceipt(cashier, walkin.sale.id, { onceKey: key('w1') }), /no customer on it/, 'NO_CUSTOMER');
    await refused('email is not set up yet, and says so', () => sendReceipt(cashier, s1.sale.id, { onceKey: key('w2'), channel: 'EMAIL' }), /Email receipts are not set up yet/, 'NOT_CONFIGURED');

    server = await serveWhatsApp();
    const port = (server.address() as AddressInfo).port;
    process.env.WHATSAPP_SERVICE_URL = `http://127.0.0.1:${port}`;
    process.env.WHATSAPP_MODULE_KEY = MODULE_KEY;

    wa.stop.add(customer.phone);
    await refused('the person replied STOP: the service\'s own words come through',
      () => sendReceipt(cashier, s1.sale.id, { onceKey: key('w3') }), /replied STOP/, 'SEND_FAILED');
    ok('and the bill is exactly as it was', await same());
    wa.stop.clear();

    server.close();
    await refused('the service is down: said plainly, the bill is saved',
      () => sendReceipt(cashier, s1.sale.id, { onceKey: key('w4') }), /could not be reached\. The bill is saved/, 'SEND_FAILED');
    ok('and the bill is still exactly as it was', await same());
    const soldMeanwhile = await completeSale(cashier, { onceKey: key('meanwhile'), counterId, lines: [{ itemId: cotton.id, qty: 1 }], payments: [{ method: 'CASH', amountPaise: 129900 }] });
    ok('and selling carries on while WhatsApp is down', !!soldMeanwhile.sale.invoiceNo);
    server = await serveWhatsApp(port);

    // ==========================================================================================
    console.log('\nWhatsApp: sending');
    // ==========================================================================================
    const sent = await sendReceipt(cashier, s1.sale.id, { onceKey: key('w5') });
    eq('the service takes it', sent.send.status, 'QUEUED');
    const msg = wa.seen[0];
    eq('from the shop\'s own number, as a bill (kind C2)', [msg?.body.from?.clientId, msg?.body.kind], [DEV_CLIENT_ID, 'C2']);
    eq('to the bill\'s own customer -- the server decided, not the browser', msg?.body.to, customer.phone);
    eq('with this module\'s key', msg?.headers['x-module-key'], MODULE_KEY);
    ok('the PDF attached is a real PDF', Buffer.from(msg?.body.document?.base64 ?? '', 'base64').subarray(0, 5).toString() === '%PDF-' && msg?.body.document?.mimeType === 'application/pdf');
    ok('the message carries the online link too', String(msg?.body.text).includes(`/r/${t}`));
    eq('only the last four digits are kept on our side', sent.send.to, `••••${customer.phone.slice(-4)}`);

    const again = await sendReceipt(cashier, s1.sale.id, { onceKey: key('w5') });
    ok('pressing Send twice sends once', again.replayed && wa.seen.length === 1);

    const sends = await sendsFor(cashier, s1.sale.id);
    eq('the bill lists what was sent, newest first', sends.map(x => x.status), ['DELIVERED', 'FAILED', 'FAILED']);
    ok('the delivered tick came from the service', sends[0].status === 'DELIVERED');

    // ==========================================================================================
    console.log('\nthe UPI ID for the QR');
    // ==========================================================================================
    await refused('a cashier cannot change where UPI money goes', () => setUpiId(cashier, 'x@okaxis'), /Only the owner/);
    await refused('something that is not a UPI ID is refused, with an example', () => setUpiId(owner, 'lakshmi silks'), /name@bank/);
    const shop = await setUpiId(owner, ' LakshmiSilks@OKHDFCBANK ');
    eq('a real one is kept, tidied', (shop as any).shop.upiId, 'lakshmisilks@okhdfcbank');
    eq('and the till is told', (await forTill(cashier)).shop.upiId, 'lakshmisilks@okhdfcbank');
    eq('it can be taken away again', ((await setUpiId(owner, null)) as any).shop.upiId, null);

    // ==========================================================================================
    console.log('\ndevices');
    // ==========================================================================================
    const dev = `dev-${randomUUID()}`;
    const first = await heartbeat(cashier, { deviceId: dev, name: 'Chrome on Windows', appVersion: '0.10.0', capabilities: { camera: true, cameraScan: false, screen: '1366x768' } });
    ok('a device registers itself on first check-in', first.online && first.name === 'Chrome on Windows' && first.lastUserName === cashier.name);
    const printed = await heartbeat(cashier, { deviceId: dev, printed: true });
    ok('a print is recorded against the device', !!printed.lastPrintedAt);
    await refused('another shop cannot claim this device', () => heartbeat({ ...cashier, clientId: 'someone-else' }, { deviceId: dev }), /registered to another shop/);
    await refused('a device id that is not one is refused', () => heartbeat(cashier, { deviceId: 'x' }), /no usable id/);
    ok('it is listed, online', (await listDevices(manager)).devices.some(d => d.id === dev && d.online));
    await refused('a cashier cannot rename devices', () => updateDevice(cashier, dev, { name: 'Mine now' }), /manager or the owner/);
    const renamed = await updateDevice(manager, dev, { name: 'Counter 1 PC', counterId, paperWidthMm: 58 });
    eq('a manager names it, puts it at a counter, sets 58 mm paper', [renamed.name, renamed.counter?.id, renamed.paperWidthMm], ['Counter 1 PC', counterId, 58]);
    await refused('paper that does not exist is refused', () => updateDevice(manager, dev, { paperWidthMm: 70 }), /58 mm or 80 mm/);
    await prisma.device.update({ where: { id: dev }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
    ok('not seen for ten minutes: shown as not online', !(await listDevices(manager)).devices.find(d => d.id === dev)?.online);
    await prisma.device.delete({ where: { id: dev } });
  } finally {
    server?.close();
    if (savedEnv.url) process.env.WHATSAPP_SERVICE_URL = savedEnv.url; else delete process.env.WHATSAPP_SERVICE_URL;
    if (savedEnv.key) process.env.WHATSAPP_MODULE_KEY = savedEnv.key; else delete process.env.WHATSAPP_MODULE_KEY;
    await prisma.shopSettings.update({ where: { clientId: DEV_CLIENT_ID }, data: { upiId: savedUpi } });
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
