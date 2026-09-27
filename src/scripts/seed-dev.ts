import { prisma } from '../lib/prisma';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';

/**
 * A shop to sell from, for local work and for the verification suites.
 *
 *     npm --prefix D:\villy\pos\backend run seed:dev
 *
 * Runs against the local Postgres (src/scripts/local-db.mjs), never a real one. It refuses outside
 * development for the same reason the dev actor does: a seed script that can be pointed at
 * production is a seed script that eventually is.
 *
 * Idempotent, so running it again after a schema change is safe.
 */

const ITEMS = [
  // Real-ish stock for a saree shop, at the two GST rates clothing actually uses.
  { code: 'KAN-001', barcode: '8901234500011', name: 'Kanchipuram silk saree', colour: 'Maroon', size: 'Free', hsn: '5007', pricePaise: 1299900, taxRate: 12, cachedQty: 4 },
  { code: 'KAN-002', barcode: '8901234500028', name: 'Kanchipuram silk saree', colour: 'Bottle green', size: 'Free', hsn: '5007', pricePaise: 1499900, taxRate: 12, cachedQty: 1 },
  { code: 'COT-010', barcode: '8901234500035', name: 'Cotton saree', colour: 'Indigo', size: 'Free', hsn: '5208', pricePaise: 129900, taxRate: 5, cachedQty: 22 },
  { code: 'COT-011', barcode: '8901234500042', name: 'Cotton saree', colour: 'Mustard', size: 'Free', hsn: '5208', pricePaise: 84900, taxRate: 5, cachedQty: 0 },
  { code: 'BLO-101', barcode: '8901234500059', name: 'Blouse piece', colour: 'Maroon', size: '38', hsn: '6206', pricePaise: 44900, taxRate: 5, cachedQty: 12 },
  { code: 'BLO-102', barcode: '8901234500066', name: 'Blouse piece', colour: 'Bottle green', size: '40', hsn: '6206', pricePaise: 44900, taxRate: 5, cachedQty: 7 },
  { code: 'DUP-201', barcode: '8901234500073', name: 'Banarasi dupatta', colour: 'Gold', size: 'Free', hsn: '6214', pricePaise: 249900, taxRate: 5, cachedQty: 3 },
  { code: 'RET-900', barcode: '8901234500080', name: 'Discontinued georgette saree', colour: 'Grey', size: 'Free', hsn: '5407', pricePaise: 99900, taxRate: 5, cachedQty: 2, active: false }
];

export async function seed() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-dev refuses to run in production');
  }

  await prisma.shopSettings.upsert({
    where: { clientId: DEV_CLIENT_ID },
    update: {},
    create: {
      clientId: DEV_CLIENT_ID,
      shopName: 'Lakshmi Silks',
      gstin: '33AABCL1234M1ZP',
      address: '14 Ranganathan Street, T Nagar, Chennai 600017',
      receiptFooter: 'Thank you. Exchange within 7 days with this bill.',
      invoicePrefix: 'INV',
      creditNotePrefix: 'CN',
      enabledPaymentMethods: ['CASH', 'UPI', 'CARD'],
      manualDiscountMaxPercent: 10,
      returnWindowDays: 7,
      holdThresholdQty: 3
    }
  });

  const counter = await prisma.counter.upsert({
    where: { clientId_name: { clientId: DEV_CLIENT_ID, name: 'Counter 1' } },
    update: {},
    create: { clientId: DEV_CLIENT_ID, name: 'Counter 1' }
  });

  await prisma.user.upsert({
    where: { clientId_email: { clientId: DEV_CLIENT_ID, email: 'cashier@example.test' } },
    update: {},
    create: { id: 'dev-cashier', clientId: DEV_CLIENT_ID, name: 'Dev cashier', email: 'cashier@example.test' }
  });

  for (const item of ITEMS) {
    await prisma.item.upsert({
      where: { clientId_code: { clientId: DEV_CLIENT_ID, code: item.code } },
      update: { pricePaise: item.pricePaise, cachedQty: item.cachedQty, active: item.active ?? true },
      create: { clientId: DEV_CLIENT_ID, ...item, cachedQtyAt: new Date() }
    });
  }

  return { counterId: counter.id, items: ITEMS.length };
}

if (require.main === module) {
  seed()
    .then(r => console.log(`seeded: counter ${r.counterId}, ${r.items} items`))
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
