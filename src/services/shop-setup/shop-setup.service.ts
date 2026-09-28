import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';
import { PERMISSIONS } from '../../types/actor';
import { badRequest, conflict } from '../../utils/httpError';
import { hashPassword } from '../auth';

/**
 * Setting up a new shop in the POS. Phase 13 -- how sphl (and every shop after it) gets a till.
 *
 * Called by ScaleEzy, not by a shop: POST /api/v1/platform/shops with the platform key. It makes,
 * in one transaction: the shop's settings, its roles and what each may do, one counter, and the
 * owner (password to open the till, PIN to bill). The owner then adds their own staff on the Staff
 * screen. Running it twice for the same shop is refused -- a shop is set up once.
 *
 * `clientId` should be the shop's id on the ScaleEzy platform (the same one Inventory uses), so the
 * two modules agree on who the shop is.
 */

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: Object.values(PERMISSIONS),
  MANAGER: [
    PERMISSIONS.SELL, PERMISSIONS.DISCOUNT_OVER_LIMIT, PERMISSIONS.PRICE_OVERRIDE,
    PERMISSIONS.REFUND, PERMISSIONS.REFUND_OUTSIDE_WINDOW, PERMISSIONS.CLOSE_DAY,
    PERMISSIONS.CASH_OUT, PERMISSIONS.REPORTS
  ],
  CASHIER: [PERMISSIONS.SELL]
};

/** Every permission key as a row, and this shop's three roles with theirs. Safe to run again. */
export async function ensureRoles(clientId: string) {
  for (const key of Object.values(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  const perms = await prisma.permission.findMany({ select: { id: true, key: true } });
  const ids: Record<string, string> = {};
  for (const [name, keys] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { clientId_name: { clientId, name } }, update: {}, create: { clientId, name, isSystem: true }
    });
    ids[name] = role.id;
    for (const p of perms.filter(x => keys.includes(x.key))) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: p.id } }, update: {}, create: { roleId: role.id, permissionId: p.id }
      });
    }
  }
  return ids;
}

export interface NewShop {
  clientId: string;
  shopName: string;
  gstin?: string | null;
  address?: string | null;
  counterName?: string;
  owner: { name: string; email?: string | null; phone?: string | null; password: string; pin: string };
}

export async function createShop(input: NewShop) {
  const clientId = (input.clientId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(clientId)) throw badRequest('clientId: the shop\'s platform id, letters, numbers, - and _.');
  const shopName = (input.shopName ?? '').trim();
  if (shopName.length < 2) throw badRequest('shopName is required.');
  if (input.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(input.gstin.trim().toUpperCase())) throw badRequest('That GSTIN is not 15 characters in the usual form.');
  const o = input.owner ?? ({} as NewShop['owner']);
  if ((o.name ?? '').trim().length < 2) throw badRequest('owner.name is required.');
  const email = (o.email ?? '').trim().toLowerCase() || null;
  const digits = (o.phone ?? '').replace(/\D/g, '');
  const phone = digits.length === 10 ? `+91${digits}` : digits.length === 12 && digits.startsWith('91') ? `+${digits}` : null;
  if (!email && !phone) throw badRequest('The owner needs an email or a 10-digit phone to sign in with.');
  if (!/^\d{4}$/.test(o.pin ?? '')) throw badRequest('owner.pin is 4 digits.');
  const passwordHash = await hashPassword(o.password);

  if (await prisma.shopSettings.findUnique({ where: { clientId }, select: { clientId: true } })) {
    throw conflict('That shop is already set up in the POS.', { code: 'SHOP_EXISTS' });
  }

  const roleIds = await ensureRoles(clientId);
  const result = await prisma.$transaction(async (tx) => {
    await tx.shopSettings.create({
      data: {
        clientId, shopName: shopName.slice(0, 80), gstin: input.gstin?.trim().toUpperCase() || null, address: input.address?.trim() || null,
        receiptFooter: 'Thank you for shopping with us.', invoicePrefix: 'INV', creditNotePrefix: 'CN',
        enabledPaymentMethods: ['CASH', 'UPI', 'CARD'], manualDiscountMaxPercent: 10, returnWindowDays: 7, holdThresholdQty: 3
      }
    });
    const counter = await tx.counter.create({ data: { clientId, name: (input.counterName ?? 'Counter 1').slice(0, 40) }, select: { id: true, name: true } });
    const owner = await tx.user.create({
      data: {
        clientId, name: o.name.trim().slice(0, 60), email, phone, passwordHash, approvalPinHash: await bcrypt.hash(o.pin, 10),
        roles: { create: { roleId: roleIds.OWNER } }
      },
      select: { id: true, name: true }
    });
    return { counter, owner };
  });
  return { clientId, shopName, counter: result.counter.name, owner: result.owner.name, signInWith: email ?? phone };
}
