import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { Actor, holdsEverything, may, PERMISSIONS } from '../../types/actor';
import { badRequest, forbidden, notFound, unauthorized } from '../../utils/httpError';
import { record } from '../audit';

/**
 * Signing in at the till. POS-CORE-002 (local mode). Approved 27 Sep: password once, then a PIN.
 *
 *   OPEN THE TILL   an owner or manager signs in on the device with email/phone + password. The
 *                   device gets a TILL token (30 days, until someone closes the till).
 *   WHO IS BILLING  staff tap their name and type their 4-digit PIN. That gives a STAFF token
 *                   (12 hours). Every bill carries that person, and Switch brings the names back
 *                   without closing anything.
 *   CLOSE THE TILL  ends the till session: both tokens stop working on that device at once.
 *
 * The PIN is the same one a manager already uses to approve a discount -- one number per person.
 *
 * A wrong password and an unknown email get the SAME answer: which emails exist is not something
 * to confirm to whoever is guessing. Five wrong tries lock that login (or that person's PIN) for a
 * while; the lock is per server process, which is enough for one instance and is said so here.
 */

const TILL_DAYS = 30;
const STAFF_HOURS = 12;
const LOCK_AFTER = 5;
const LOCK_MS = 5 * 60_000;

type Claims = { typ: 'till' | 'staff'; cid: string; tid: string; sub?: string };

const sign = (c: Claims, expiresIn: string) => jwt.sign(c, env.JWT_SECRET, { algorithm: 'HS256', expiresIn, issuer: 'scaleezy-pos' } as jwt.SignOptions);

export function readToken(raw: string | undefined, typ: 'till' | 'staff'): Claims {
  if (!raw) throw unauthorized('Please sign in.', { code: typ === 'till' ? 'TILL_CLOSED' : 'NO_STAFF' });
  try {
    const c = jwt.verify(raw, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'scaleezy-pos' }) as Claims;
    if (c.typ !== typ || !c.cid || !c.tid) throw new Error('wrong kind');
    return c;
  } catch {
    // An expired staff token is the ordinary end of a shift: choose your name again. An expired
    // till token means the till has to be opened again.
    throw unauthorized(typ === 'till' ? 'This till has been closed. An owner or manager needs to open it.' : 'Choose your name and enter your PIN.',
      { code: typ === 'till' ? 'TILL_CLOSED' : 'NO_STAFF' });
  }
}

// ---- lockouts ---------------------------------------------------------------------------------
const fails = new Map<string, { count: number; until: number }>();
function checkLock(key: string) {
  const r = fails.get(key);
  if (r && r.until > Date.now()) {
    const mins = Math.ceil((r.until - Date.now()) / 60_000);
    throw unauthorized(`Too many wrong tries. Wait ${mins} minute${mins === 1 ? '' : 's'} and try again.`, { code: 'LOCKED' });
  }
}
function failed(key: string) {
  const r = fails.get(key) ?? { count: 0, until: 0 };
  r.count++;
  if (r.count >= LOCK_AFTER) { r.until = Date.now() + LOCK_MS; r.count = 0; }
  fails.set(key, r);
}
export const __resetAuthLocks = () => fails.clear();

// ---- the till session, cached so a sale does not pay a database trip to ask "still open?" -------
const openCache = new Map<string, number>();
const CACHE_MS = 30_000;
async function mustBeOpen(clientId: string, tid: string) {
  const at = openCache.get(tid);
  if (at && Date.now() - at < CACHE_MS) return;
  const s = await prisma.tillSession.findFirst({ where: { id: tid, clientId }, select: { closedAt: true } });
  if (!s || s.closedAt) {
    openCache.delete(tid);
    throw unauthorized('This till has been closed. An owner or manager needs to open it.', { code: 'TILL_CLOSED' });
  }
  openCache.set(tid, Date.now());
}

const USER_SELECT = {
  id: true, clientId: true, name: true, email: true, phone: true, passwordHash: true, approvalPinHash: true, status: true, deletedAt: true,
  roles: { select: { role: { select: { name: true, permissions: { select: { permission: { select: { key: true } } } } } } } }
} as const;

function toActor(u: { id: string; clientId: string; name: string | null; roles: { role: { name: string; permissions: { permission: { key: string } }[] } }[] }): Actor {
  return {
    kind: 'USER', clientId: u.clientId, id: u.id, name: u.name,
    roles: u.roles.map(r => r.role.name),
    permissions: [...new Set(u.roles.flatMap(r => r.role.permissions.map(p => p.permission.key)))]
  };
}

/** The person a staff token belongs to, as an Actor -- or a refusal. Used on every request. */
export async function actorFromStaffToken(raw: string): Promise<Actor> {
  const c = readToken(raw, 'staff');
  await mustBeOpen(c.cid, c.tid);
  const u = await prisma.user.findFirst({ where: { id: c.sub, clientId: c.cid, status: 'ACTIVE', deletedAt: null }, select: USER_SELECT });
  if (!u) throw unauthorized('Choose your name and enter your PIN.', { code: 'NO_STAFF' });
  return toActor(u);
}

const mayOpen = (a: Actor) => holdsEverything(a) || may(a, PERMISSIONS.CLOSE_DAY) || may(a, PERMISSIONS.SETTINGS);

const normalisePhone = (s: string) => {
  const d = s.replace(/\D/g, '');
  return d.length === 10 ? `+91${d}` : d.length === 12 && d.startsWith('91') ? `+${d}` : null;
};

/** Open the till: email or phone + password, owner or manager. */
export async function openTill(input: { login?: string; password?: string; shopId?: string; deviceId?: string }) {
  const login = (input.login ?? '').trim().toLowerCase();
  const password = input.password ?? '';
  if (!login || !password) throw badRequest('Enter your email or phone number, and your password.');
  const lockKey = `open:${login}`;
  checkLock(lockKey);

  const phone = normalisePhone(login);
  const candidates = await prisma.user.findMany({
    where: {
      status: 'ACTIVE', deletedAt: null, passwordHash: { not: null },
      OR: [{ email: login }, ...(phone ? [{ phone }] : [])],
      ...(input.shopId ? { clientId: input.shopId } : {})
    },
    select: USER_SELECT
  });
  const matching: typeof candidates = [];
  for (const u of candidates) if (await bcrypt.compare(password, u.passwordHash!)) matching.push(u);
  if (matching.length === 0) {
    failed(lockKey);
    throw unauthorized('That email or phone and password do not match. Check them and try again.', { code: 'BAD_LOGIN' });
  }
  fails.delete(lockKey);

  if (matching.length > 1) {
    const shops = await prisma.shopSettings.findMany({ where: { clientId: { in: matching.map(u => u.clientId) } }, select: { clientId: true, shopName: true } });
    return { chooseShop: shops.map(s => ({ id: s.clientId, name: s.shopName })) };
  }

  const u = matching[0];
  const actor = toActor(u);
  if (!mayOpen(actor)) {
    throw forbidden('Only an owner or manager opens the till. Ask them to open it, then choose your name.', { code: 'CANNOT_OPEN' });
  }
  const session = await prisma.tillSession.create({
    data: { clientId: u.clientId, openedById: u.id, deviceId: input.deviceId?.slice(0, 80) ?? null }
  });
  await record(actor, { action: 'till.opened', detail: { deviceId: input.deviceId ?? null } });
  const shop = await prisma.shopSettings.findUnique({ where: { clientId: u.clientId }, select: { shopName: true } });
  return {
    tillToken: sign({ typ: 'till', cid: u.clientId, tid: session.id }, `${TILL_DAYS}d`),
    // The person who opened it is at the till straight away.
    staffToken: sign({ typ: 'staff', cid: u.clientId, tid: session.id, sub: u.id }, `${STAFF_HOURS}h`),
    shop: { name: shop?.shopName ?? 'Your shop' },
    person: { id: u.id, name: u.name }
  };
}

/** The names on the "Who's at the till?" screen: active staff who have a PIN. */
export async function staffOnTill(tillToken: string | undefined) {
  const c = readToken(tillToken, 'till');
  await mustBeOpen(c.cid, c.tid);
  const users = await prisma.user.findMany({
    where: { clientId: c.cid, status: 'ACTIVE', deletedAt: null, approvalPinHash: { not: null } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, roles: { select: { role: { select: { name: true } } } } }
  });
  const shop = await prisma.shopSettings.findUnique({ where: { clientId: c.cid }, select: { shopName: true } });
  const ROLE: Record<string, string> = { OWNER: 'Owner', MANAGER: 'Manager', CASHIER: 'Cashier' };
  return {
    shop: { name: shop?.shopName ?? 'Your shop' },
    staff: users.map(u => ({ id: u.id, name: u.name ?? 'Staff', role: ROLE[u.roles[0]?.role.name ?? ''] ?? 'Staff' }))
  };
}

/** A person takes the till with their PIN. */
export async function switchTo(tillToken: string | undefined, input: { userId?: string; pin?: string }) {
  const c = readToken(tillToken, 'till');
  await mustBeOpen(c.cid, c.tid);
  if (!input.userId) throw badRequest('Choose your name first.');
  if (!/^\d{4,6}$/.test(input.pin ?? '')) throw badRequest('Enter your PIN.');
  const lockKey = `pin:${c.cid}:${input.userId}`;
  checkLock(lockKey);
  const u = await prisma.user.findFirst({ where: { id: input.userId, clientId: c.cid, status: 'ACTIVE', deletedAt: null }, select: USER_SELECT });
  if (!u || !u.approvalPinHash) throw notFound('That name is not on this till any more. Choose again.');
  if (!(await bcrypt.compare(input.pin!, u.approvalPinHash))) {
    failed(lockKey);
    throw unauthorized('That PIN is not right. Try again.', { code: 'BAD_PIN' });
  }
  fails.delete(lockKey);
  return {
    staffToken: sign({ typ: 'staff', cid: c.cid, tid: c.tid, sub: u.id }, `${STAFF_HOURS}h`),
    person: { id: u.id, name: u.name }
  };
}

/** Close the till on this device. Anyone at it may -- closing is always safe. */
export async function closeTill(tillToken: string | undefined, by: Actor | null) {
  const c = readToken(tillToken, 'till');
  const r = await prisma.tillSession.updateMany({ where: { id: c.tid, clientId: c.cid, closedAt: null }, data: { closedAt: new Date(), closedById: by?.id ?? null } });
  openCache.delete(c.tid);
  /*
   * Recorded, like closing every till is. Closing one is the smaller act but it is the one that
   * actually happens, and an owner asking "why did the counter sign itself out in the middle of
   * trade?" was getting nothing at all: Activity showed six "Till opened" in an afternoon and not
   * one close (6 Oct). A sign-out a person did not expect looks like a fault until the log says
   * who did it.
   */
  if (r.count && by) await record(by, { action: 'till.closed', detail: { everywhere: false } });
  return { closed: true };
}

/** Owners and managers can close every till of the shop -- a lost tablet. */
export async function closeAllTills(actor: Actor) {
  if (!mayOpen(actor)) throw forbidden('Only an owner or manager can close the tills.', { code: 'NOT_PERMITTED' });
  const r = await prisma.tillSession.updateMany({ where: { clientId: actor.clientId, closedAt: null }, data: { closedAt: new Date(), closedById: actor.id } });
  openCache.clear();
  await record(actor, { action: 'till.closed', detail: { tills: r.count, everywhere: true } });
  return { closed: r.count };
}

/** Passwords: long enough to not be guessed, short enough to type at a counter. */
export async function hashPassword(pw: string) {
  if ((pw ?? '').length < 8) throw badRequest('Use a password of at least 8 characters.');
  return bcrypt.hash(pw, 10);
}

export const newId = () => crypto.randomUUID();
