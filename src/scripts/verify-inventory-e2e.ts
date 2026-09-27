/**
 * verify-inventory-e2e -- the POS against the REAL Inventory. Phase 8.
 *
 *     POS_E2E_URL=http://localhost:4006/api/v1/pos/v1 POS_E2E_KEY=sk_... POS_E2E_CODES=A,B,C \
 *       npx ts-node src/scripts/verify-inventory-e2e.ts
 *
 * Needs a throwaway Inventory tenant made for the purpose (the Inventory session makes one and
 * sends the key; it tears it down). Nothing here is a stand-in: connecting tries the real key, the
 * catalogue comes from Inventory's real feed, sales go to Inventory's real intake and stock is read
 * back from Inventory. The key is taken from the environment and never written to a file.
 *
 * On the POS side it makes a shop of its own (client id `e2e-<time>`) and deletes it at the end.
 *
 * SLOW BY NATURE: Inventory's database is in Singapore and one sale is ~a dozen statements in one
 * transaction -- 12 to 56 seconds each, measured. Expect a few minutes.
 */

import { prisma } from '../lib/prisma';
import { Actor, PERMISSIONS } from '../types/actor';
import { completeSale } from '../services/sale';
import { createReturn } from '../services/returns';
import { findOrCreate } from '../services/customers';
import { connect, status, syncCatalogue, deliverNext } from '../services/inventory-link';
import { call } from '../services/inventory-link/client';
import { toInventory } from '../services/inventory-link';

let passed = 0;
let failed = 0;
const ok = (name: string, condition: boolean, detail = '') => {
  if (condition) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const URL_ = process.env.POS_E2E_URL!;
const KEY = process.env.POS_E2E_KEY!;
const CODES = (process.env.POS_E2E_CODES ?? '').split(',').filter(Boolean);

async function deliverAll(clientId: string, label: string) {
  const out: string[] = [];
  for (let i = 0; i < 20; i++) {
    const t = Date.now();
    const r = await deliverNext(clientId);
    out.push(`${r.outcome}${r.sequence ? `#${r.sequence}` : ''} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    if (r.outcome !== 'DELIVERED') break;
  }
  console.log(`      (${label}: ${out.join(', ')})`);
  return out;
}

async function main() {
  if (!URL_ || !KEY || CODES.length < 3) throw new Error('Set POS_E2E_URL, POS_E2E_KEY and POS_E2E_CODES (three codes).');
  console.log('\nverify-inventory-e2e  (against the real Inventory)\n');

  const clientId = `e2e-${Date.now()}`;
  const owner: Actor = { kind: 'USER', clientId, id: null, name: 'E2E owner', roles: ['OWNER'], permissions: Object.values(PERMISSIONS) };
  await prisma.shopSettings.create({
    data: { clientId, shopName: 'E2E test shop', enabledPaymentMethods: ['CASH', 'UPI', 'CARD'], invoicePrefix: 'E2E', creditNotePrefix: 'ECN' }
  });
  const counter = await prisma.counter.create({ data: { clientId, name: 'E2E counter' }, select: { id: true } });

  try {
    // ==========================================================================================
    console.log('connect and load the catalogue');
    // ==========================================================================================
    const linked = await connect(owner, { key: KEY, baseUrl: URL_ });
    eq('the real key is accepted by the real Inventory', linked.mode, 'CONNECTED');

    const sync = await syncCatalogue(owner);
    ok('the catalogue arrives', sync.added >= 3, JSON.stringify(sync));
    const items = await prisma.item.findMany({ where: { clientId, code: { in: CODES } }, orderBy: { code: 'asc' } });
    eq('all three test products are in the till', items.length, 3);
    console.log('      ' + items.map(i => `${i.code} ${i.name} ${i.pricePaise} paise ${i.taxRate}% HSN ${i.hsn} qty ${i.cachedQty}`).join('\n      '));
    ok('prices came across as paise integers', items.every(i => Number.isInteger(i.pricePaise) && i.pricePaise > 0));
    ok('GST as the shop typed it: 5, 5, 18', JSON.stringify(items.map(i => i.taxRate)) === '[5,5,18]', JSON.stringify(items.map(i => i.taxRate)));
    ok('stock as Inventory has it', items.every(i => i.cachedQty === 25), JSON.stringify(items.map(i => i.cachedQty)));
    if (sync.problems.length) console.log('      problems: ' + sync.problems.join(' | '));
    const [cotton, silk, lehenga] = items;

    // ==========================================================================================
    console.log('\nsell: a walk-in, a customer with a phone, an 18% piece');
    // ==========================================================================================
    const s1 = await completeSale(owner, {
      onceKey: `${clientId}-s1`, counterId: counter.id, lines: [{ itemId: cotton.id, qty: 2 }],
      payments: [{ method: 'CASH', amountPaise: cotton.pricePaise * 2 }]
    });
    // The seed's mistake, on purpose: silk at 12% in the till against 5% in Inventory.
    await prisma.item.update({ where: { id: silk.id }, data: { taxRate: 12 } });
    const { customer } = await findOrCreate(owner, { phone: '9' + String(Date.now()).slice(-9), name: 'E2E customer' });
    const s2 = await completeSale(owner, {
      onceKey: `${clientId}-s2`, counterId: counter.id, customerId: customer.id, lines: [{ itemId: silk.id, qty: 1 }],
      payments: [{ method: 'UPI', amountPaise: silk.pricePaise, reference: 'E2E-UPI' }]
    });
    const s3 = await completeSale(owner, {
      onceKey: `${clientId}-s3`, counterId: counter.id, lines: [{ itemId: lehenga.id, qty: 1 }],
      payments: [{ method: 'CARD', amountPaise: lehenga.pricePaise, reference: 'E2E-CARD' }]
    });
    eq('the till made three bills', [s1, s2, s3].map(x => !!x.sale.invoiceNo), [true, true, true]);

    // ==========================================================================================
    console.log('\ndeliver them to Inventory');
    // ==========================================================================================
    const sent = await deliverAll(clientId, 'sales');
    eq('all three delivered, in order', sent.filter(x => x.startsWith('DELIVERED')).length, 3);
    const st: any = await status(owner);
    eq('nothing waiting', st.waiting, 0);
    eq('the queue is not stopped', st.blocked, null);
    console.log('      warnings: ' + JSON.stringify(st.warnings.map((w: any) => w.text)));
    ok('Inventory noted the 12% vs 5% silk, and recorded it anyway', st.warnings.some((w: any) => /12%/.test(w.text) && /5%/.test(w.text)));

    const stock = await call({ baseUrl: URL_, keyCipher: (await prisma.inventoryLink.findUniqueOrThrow({ where: { clientId } })).keyCipher }, 'GET', `/stock?codes=${CODES.join(',')}`, undefined, 60_000);
    const byCode = Object.fromEntries(((stock as any).body?.data ?? []).map((x: any) => [x.variantCode, x.available]));
    console.log('      Inventory stock now: ' + JSON.stringify(byCode));
    eq('Inventory\'s stock moved: 25-2, 25-1, 25-1', [byCode[cotton.code], byCode[silk.code], byCode[lehenga.code]], [23, 24, 24]);

    // ==========================================================================================
    console.log('\nthe same sale again');
    // ==========================================================================================
    const first = await prisma.webhookEvent.findFirstOrThrow({ where: { clientId, invoiceNo: s1.sale.invoiceNo } });
    const link = await prisma.inventoryLink.findUniqueOrThrow({ where: { clientId } });
    const again = await call(link, 'POST', '/events', toInventory(first.eventType, first.payload), 90_000);
    const againBody: any = (again as any).body;
    console.log('      replay answer: ' + JSON.stringify(againBody?.data ?? againBody));
    ok('sending the walk-in sale again is ALREADY_APPLIED', (again as any).status < 300 && againBody?.data?.answer === 'ALREADY_APPLIED');
    const stock2: any = await call(link, 'GET', `/stock?codes=${cotton.code}`, undefined, 60_000);
    eq('and the stock did not move again', stock2.body?.data?.[0]?.available, 23);

    // ==========================================================================================
    console.log('\na return (Inventory checks it; the write is not built there yet)');
    // ==========================================================================================
    const r1 = await createReturn(owner, s1.sale.id, {
      onceKey: `${clientId}-r1`, counterId: counter.id, lines: [{ saleLineId: s1.sale.lines[0].id, qty: 1 }],
      reason: 'E2E return', refund: { method: 'CASH' }
    });
    await deliverAll(clientId, 'return');
    const st2: any = await status(owner);
    console.log('      Inventory said: ' + JSON.stringify(st2.blocked));
    ok('Inventory agrees with the POS on what the returned piece was worth', /amounts agree/i.test(st2.blocked?.message ?? ''), st2.blocked?.message);
    eq('and the queue stops there, as the contract says, until Inventory can write returns', st2.blocked?.document, r1.creditNote.creditNoteNo);

    // A wrong amount, sent by hand: Inventory must refuse it with both figures.
    const ev = await prisma.webhookEvent.findFirstOrThrow({ where: { clientId, invoiceNo: r1.creditNote.creditNoteNo } });
    const tampered: any = JSON.parse(JSON.stringify(ev.payload));
    tampered.lines[0].amountPaise += 500;
    const wrong: any = await call(link, 'POST', '/events', toInventory(ev.eventType, tampered), 90_000);
    console.log('      tampered answer: ' + JSON.stringify(wrong.body?.data ?? wrong.body));
    eq('a return worth Rs 5 more than the POS worked out is refused as AMOUNT_MISMATCH', wrong.body?.data?.answer, 'AMOUNT_MISMATCH');
  } finally {
    const saleIds = (await prisma.sale.findMany({ where: { clientId }, select: { id: true } })).map(s => s.id);
    await prisma.returnRefund.deleteMany({ where: { clientId } });
    await prisma.returnLine.deleteMany({ where: { returnRow: { clientId } } });
    await prisma.approval.deleteMany({ where: { clientId } });
    await prisma.return.deleteMany({ where: { clientId } });
    await prisma.payment.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.saleLine.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { clientId } });
    await prisma.webhookEvent.deleteMany({ where: { clientId } });
    await prisma.inventoryLink.deleteMany({ where: { clientId } });
    await prisma.item.deleteMany({ where: { clientId } });
    await prisma.customer.deleteMany({ where: { clientId } });
    await prisma.auditLog.deleteMany({ where: { clientId } });
    await prisma.invoiceSeries.deleteMany({ where: { clientId } });
    await prisma.counter.deleteMany({ where: { clientId } });
    await prisma.shopSettings.deleteMany({ where: { clientId } });
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
