import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';
import { PERMISSIONS } from '../../types/actor';
import { badRequest, conflict } from '../../utils/httpError';
import { cleanPin, cleanEmail, cleanPhone } from '../staff/staff.service';
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
    PERMISSIONS.CASH_OUT, PERMISSIONS.PAYMENT_VOID, PERMISSIONS.REPORTS, PERMISSIONS.PAY_LATER,
    PERMISSIONS.CUSTOMER_GSTIN, PERMISSIONS.WRITE_OFF
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
  /** Managers and cashiers, added in the same go (optional). The owner can add more later on Staff. */
  staff?: NewPerson[];
}

export interface NewPerson { name: string; role: string; pin: string; email?: string | null; phone?: string | null; password?: string | null }

const STAFF_ROLES = ['OWNER', 'MANAGER', 'CASHIER'];

/**
 * Everyone checked before anything is written: a shop half set up -- the owner made, the third
 * cashier refused -- would have to be cleaned up by hand. Same rules as the Staff screen (weak PINs,
 * a password needs a login), plus two that only matter when several people arrive at once: no two
 * with the same PIN (a PIN approves as ONE person), and no two with the same email or phone.
 */
function checkPeople(owner: NewShop['owner'], staff: NewPerson[]) {
  const people = [
    { who: 'The owner', name: owner.name, role: 'OWNER', pin: owner.pin, email: owner.email, phone: owner.phone, password: owner.password },
    ...staff.map((p, i) => ({ who: (p.name ?? '').trim() || `Person ${i + 1}`, ...p, role: (p.role ?? 'CASHIER').toUpperCase() }))
  ];
  const pins = new Map<string, string>();
  const logins = new Map<string, string>();
  return people.map((p, i) => {
    const name = (p.name ?? '').trim();
    if (name.length < 2) throw badRequest(`${i === 0 ? 'The owner' : `Person ${i}`} needs a name.`);
    if (!STAFF_ROLES.includes(p.role)) throw badRequest(`${p.who}: choose Owner, Manager or Cashier.`);
    let pin: string;
    try { pin = cleanPin(p.pin ?? ''); } catch (e) { throw badRequest(`${p.who}: ${(e as Error).message}`); }
    if (pins.has(pin)) throw badRequest(`${p.who} and ${pins.get(pin)} have the same PIN. Each person needs their own — a PIN approves as one person.`);
    pins.set(pin, p.who);
    let email: string | null; let phone: string | null;
    try { email = cleanEmail(p.email); phone = cleanPhone(p.phone); } catch (e) { throw badRequest(`${p.who}: ${(e as Error).message}`); }
    for (const login of [email, phone].filter(Boolean) as string[]) {
      if (logins.has(login)) throw badRequest(`${p.who} and ${logins.get(login)} have the same ${login.includes('@') ? 'email' : 'phone'}.`);
      logins.set(login, p.who);
    }
    if (i === 0 && !email && !phone) throw badRequest('The owner needs an email or a 10-digit phone to open the till with.');
    if (i === 0 && !p.password) throw badRequest('The owner needs a password to open the till with.');
    if (p.password && !email && !phone) throw badRequest(`${p.who}: a password needs an email or phone to sign in with.`);
    if (p.password && p.password.length < 8) throw badRequest(`${p.who}: use a password of at least 8 characters.`);
    return { name: name.slice(0, 60), role: p.role, pin, email, phone, password: p.password || null };
  });
}

export async function createShop(input: NewShop) {
  const clientId = (input.clientId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(clientId)) throw badRequest('clientId: the shop\'s platform id, letters, numbers, - and _.');
  const shopName = (input.shopName ?? '').trim();
  if (shopName.length < 2) throw badRequest('shopName is required.');
  if (input.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(input.gstin.trim().toUpperCase())) throw badRequest('That GSTIN is not 15 characters in the usual form.');
  const staff = Array.isArray(input.staff) ? input.staff.slice(0, 30) : [];
  const people = checkPeople(input.owner ?? ({} as NewShop['owner']), staff);
  // Hashed before the transaction: bcrypt is slow, and a transaction should not wait on it.
  const hashed = await Promise.all(people.map(async p => ({
    ...p,
    passwordHash: p.password ? await hashPassword(p.password) : null,
    pinHash: await bcrypt.hash(p.pin, 10)
  })));

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
    const made = [];
    for (const p of hashed) {
      made.push(await tx.user.create({
        data: {
          clientId, name: p.name, email: p.email, phone: p.phone, passwordHash: p.passwordHash, approvalPinHash: p.pinHash,
          roles: { create: { roleId: roleIds[p.role] } }
        },
        select: { id: true, name: true }
      }));
    }
    return { counter, made };
  });
  const [owner] = hashed;
  return {
    clientId, shopName, counter: result.counter.name, owner: result.made[0].name, signInWith: owner.email ?? owner.phone,
    /** Everyone made, and how each gets in. Never a PIN or a password. */
    people: hashed.map(p => ({ name: p.name, role: p.role, opensTillWith: p.passwordHash ? (p.email ?? p.phone) : null }))
  };
}
