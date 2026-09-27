import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { PERMISSIONS } from '../types/actor';
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

/**
 * A swatch, as a data URI.
 *
 * Real image data, not a placeholder URL: the seed must work with no network and no image host,
 * and a broken <img> in dev teaches nothing about whether the layout handles pictures. Each is
 * under 200 bytes, which is also a fair test that the sell screen does not lean on large images.
 */
const swatch = (hex: string) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${hex}"/>` +
    `<rect x="4" y="4" width="56" height="56" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2"/>` +
    `</svg>`
  );

const ITEMS = [
  // Real-ish stock for a saree shop, at the two GST rates clothing actually uses.
  //
  // `variantGroup` is what turns five near-identical search results into one row and a picker
  // (POS-SELL-006). Items with no group stand alone, which is the common case for a one-off piece.
  { code: 'KAN-001', barcode: '8901234500011', name: 'Kanchipuram silk saree', colour: 'Maroon', size: 'Free', hsn: '5007', pricePaise: 1299900, taxRate: 12, cachedQty: 4, variantGroup: 'kanchipuram-silk', imageUrl: swatch('#7f1d1d') },
  { code: 'KAN-002', barcode: '8901234500028', name: 'Kanchipuram silk saree', colour: 'Bottle green', size: 'Free', hsn: '5007', pricePaise: 1499900, taxRate: 12, cachedQty: 1, variantGroup: 'kanchipuram-silk', imageUrl: swatch('#14532d') },
  { code: 'KAN-003', barcode: '8901234500097', name: 'Kanchipuram silk saree', colour: 'Peacock blue', size: 'Free', hsn: '5007', pricePaise: 1399900, taxRate: 12, cachedQty: 0, variantGroup: 'kanchipuram-silk', imageUrl: swatch('#155e75') },
  { code: 'COT-010', barcode: '8901234500035', name: 'Cotton saree', colour: 'Indigo', size: 'Free', hsn: '5208', pricePaise: 129900, taxRate: 5, cachedQty: 22, variantGroup: 'cotton-saree', imageUrl: swatch('#312e81') },
  { code: 'COT-011', barcode: '8901234500042', name: 'Cotton saree', colour: 'Mustard', size: 'Free', hsn: '5208', pricePaise: 84900, taxRate: 5, cachedQty: 0, variantGroup: 'cotton-saree', imageUrl: swatch('#a16207') },
  { code: 'BLO-101', barcode: '8901234500059', name: 'Blouse piece', colour: 'Maroon', size: '38', hsn: '6206', pricePaise: 44900, taxRate: 5, cachedQty: 12, variantGroup: 'blouse-piece', imageUrl: swatch('#7f1d1d') },
  { code: 'BLO-102', barcode: '8901234500066', name: 'Blouse piece', colour: 'Bottle green', size: '40', hsn: '6206', pricePaise: 44900, taxRate: 5, cachedQty: 7, variantGroup: 'blouse-piece', imageUrl: swatch('#14532d') },
  // No group: a single piece with no siblings, so tapping it must NOT open a picker.
  { code: 'DUP-201', barcode: '8901234500073', name: 'Banarasi dupatta', colour: 'Gold', size: 'Free', hsn: '6214', pricePaise: 249900, taxRate: 5, cachedQty: 3, imageUrl: swatch('#a16207') },
  // No image either, so the screen is exercised with a missing picture as well as with one.
  { code: 'RET-900', barcode: '8901234500080', name: 'Discontinued georgette saree', colour: 'Grey', size: 'Free', hsn: '5407', pricePaise: 99900, taxRate: 5, cachedQty: 2, active: false }
];

/**
 * The people in the shop, with real roles and real permissions.
 *
 * Phase 4 needs someone to ASK and someone to APPROVE, and they have to be different people with
 * genuinely different rights -- a stand-in that holds every permission can never see an approval
 * screen, because it never needs one.
 *
 * PINS ARE DEV-ONLY AND WRITTEN DOWN HERE ON PURPOSE. They exist so the approval flow can be
 * driven by hand and by the suites. This file refuses to run in production (see seed()), so these
 * never become anyone's real PIN.
 *
 *   dev-cashier    CASHIER    no PIN      sells; must ask for anything over the limit
 *   dev-manager    MANAGER    2468        approves discounts, overrides, refunds
 *   dev-manager-2  MANAGER    9753        a second manager, for "cannot approve your own"
 *   dev-owner      OWNER      1357        holds everything
 *   dev-senior     CASHIER    4455        HAS a PIN but no right to approve -- the case where a
 *                                         PIN is real and the answer must still be no
 */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: Object.values(PERMISSIONS),
  MANAGER: [
    PERMISSIONS.SELL, PERMISSIONS.DISCOUNT_OVER_LIMIT, PERMISSIONS.PRICE_OVERRIDE,
    PERMISSIONS.REFUND, PERMISSIONS.REFUND_OUTSIDE_WINDOW, PERMISSIONS.CLOSE_DAY,
    PERMISSIONS.CASH_OUT
  ],
  CASHIER: [PERMISSIONS.SELL]
};

const STAFF = [
  { id: 'dev-cashier', name: 'Dev cashier', email: 'cashier@example.test', role: 'CASHIER', pin: null },
  { id: 'dev-manager', name: 'Meena (manager)', email: 'manager@example.test', role: 'MANAGER', pin: '2468' },
  { id: 'dev-manager-2', name: 'Suresh (manager)', email: 'manager2@example.test', role: 'MANAGER', pin: '9753' },
  { id: 'dev-owner', name: 'Lakshmi (owner)', email: 'owner@example.test', role: 'OWNER', pin: '1357' },
  { id: 'dev-senior', name: 'Ravi (senior cashier)', email: 'senior@example.test', role: 'CASHIER', pin: '4455' }
];

async function seedStaff() {
  // Permission keys are ROWS, not an enum -- adding one never needs a migration.
  for (const key of Object.values(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }

  const roleIds: Record<string, string> = {};
  for (const [name, keys] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { clientId_name: { clientId: DEV_CLIENT_ID, name } },
      update: {},
      create: { clientId: DEV_CLIENT_ID, name, isSystem: true }
    });
    roleIds[name] = role.id;

    const perms = await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
    for (const perm of perms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id }
      });
    }
  }

  for (const person of STAFF) {
    const pinHash = person.pin ? await bcrypt.hash(person.pin, 10) : null;
    await prisma.user.upsert({
      where: { id: person.id },
      update: { name: person.name, approvalPinHash: pinHash, status: 'ACTIVE' },
      create: {
        id: person.id, clientId: DEV_CLIENT_ID, name: person.name, email: person.email,
        approvalPinHash: pinHash
      }
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: person.id, roleId: roleIds[person.role] } },
      update: {},
      create: { userId: person.id, roleId: roleIds[person.role] }
    });
  }
}

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

  await seedStaff();

  for (const item of ITEMS) {
    await prisma.item.upsert({
      where: { clientId_code: { clientId: DEV_CLIENT_ID, code: item.code } },
      update: {
        pricePaise: item.pricePaise, cachedQty: item.cachedQty, active: item.active ?? true,
        variantGroup: (item as any).variantGroup ?? null, imageUrl: (item as any).imageUrl ?? null
      },
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
