import crypto from 'crypto';
import { offlineKeyFor, readMakerStamp, MakerStamp } from './maker-stamp';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { Actor, holdsEverything, may, PERMISSIONS, systemActor } from '../../types/actor';
import { badRequest, forbidden, notFound, unauthorized } from '../../utils/httpError';
import { record } from '../audit';
import { makeLockout, waitWords } from './lockout';

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

// ---- lockouts (see ./lockout.ts: escalating, reserved before the slow compare) ---------------
// 5 wrong tries, then 5 min, 10, 20, 40, then an hour each time, until a right answer or a quiet day.
const signInLock = makeLockout({ after: 5, baseMs: 5 * 60_000, maxMs: 60 * 60_000, forgetAfterMs: 24 * 60 * 60_000 });
export const __resetAuthLocks = () => signInLock.reset();
const lockedOut = (retryInMs: number) => unauthorized(`Too many wrong tries. ${waitWords(retryInMs)}`, { code: 'LOCKED' });

/*
 * An unknown login pays for one bcrypt compare too, against this throwaway hash, so how long the
 * answer takes does not say which emails and phones exist (17 Nov audit: it used to skip the work).
 */
const NOBODY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

// ---- the till session, cached so a sale does not pay a database trip to ask "still open?" -------
const openCache = new Map<string, number>();
const CACHE_MS = 30_000;
async function mustBeOpen(clientId: string, tid: string) {
  const at = openCache.get(tid);
  if (at && Date.now() - at < CACHE_MS) return;
  const s = await prisma.tillSession.findFirst({ where: { id: tid, clientId }, select: { closedAt: true, closedById: true } });
  /*
   * CLOSED and NEVER-HEARD-OF are not the same thing, and sending both as TILL_CLOSED cost a day.
   *
   * A closed till is somebody pressing a button, and the answer is to open it again. A token naming
   * a session this database has no row for is something else -- a token signed against other data,
   * or a row that went away underneath it -- and opening the till will not fix whatever did that.
   * Six sign-outs on the test shop (6 Oct) said only "This till has been closed" and so told us
   * nothing about which of the two was happening.
   */
  if (!s) {
    openCache.delete(tid);
    throw unauthorized('This device was signed in to a till that no longer exists. Open the till again.', { code: 'TILL_UNKNOWN' });
  }
  if (s.closedAt) {
    openCache.delete(tid);
    const by = s.closedById ? await prisma.user.findUnique({ where: { id: s.closedById }, select: { name: true } }) : null;
    throw unauthorized(
      by?.name
        ? `${by.name} closed this till. An owner or manager needs to open it.`
        : 'This till has been closed. An owner or manager needs to open it.',
      { code: 'TILL_CLOSED' }
    );
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

/*
 * WHO SOMEONE IS, REMEMBERED FOR 30 SECONDS (17 Nov, measured live). Loading a person with their roles
 * and permissions is five database trips one after another -- about 70 ms of every request on Render,
 * paid again by each of the five or six calls a screen makes. Held like the till-open check above, for
 * the same 30 s, and dropped at once when anyone's name, role or standing changes (forgetStaff).
 */
const actorCache = new Map<string, { actor: Actor; at: number }>();
export function forgetStaff() { actorCache.clear(); }

/** The person a staff token belongs to, as an Actor -- or a refusal. Used on every request. */
export async function actorFromStaffToken(raw: string): Promise<Actor> {
  const c = readToken(raw, 'staff');
  await mustBeOpen(c.cid, c.tid);
  const key = `${c.cid}:${c.sub}`;
  const hit = actorCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.actor, roles: [...hit.actor.roles], permissions: [...hit.actor.permissions] };
  const u = await prisma.user.findFirst({ where: { id: c.sub, clientId: c.cid, status: 'ACTIVE', deletedAt: null }, select: USER_SELECT });
  if (!u) { actorCache.delete(key); throw unauthorized('Choose your name and enter your PIN.', { code: 'NO_STAFF' }); }
  const actor = toActor(u);
  actorCache.set(key, { actor, at: Date.now() });
  return { ...actor, roles: [...actor.roles], permissions: [...actor.permissions] };
}

/** A staff sign-in, and the key that lets its holder stamp offline sales as their own (./maker-stamp). */
const withOfflineKey = (staffToken: string) => ({ staffToken, offlineKey: offlineKeyFor(staffToken) });

/**
 * The maker of a stamped offline sale, as an Actor. The stamp proves who made it; the till's own key
 * proves the sale comes from an open till of that same shop; and the person must still work there.
 * Any doubt is one refusal (MAKER_STAMP_REFUSED), and the till then sends it as whoever is at it.
 */
export async function actorForStampedSale(input: MakerStamp & { tillToken: string | undefined }): Promise<Actor> {
  const maker = readMakerStamp(input);
  const refuse = (why: string) => unauthorized('This sale could not be matched to the person who made it.', { code: 'MAKER_STAMP_REFUSED', why });
  let till: Claims;
  try { till = readToken(input.tillToken, 'till'); } catch { throw refuse('no open till'); }
  if (till.cid !== maker.clientId) throw refuse('another shop');
  try { await mustBeOpen(till.cid, till.tid); } catch { throw refuse('till closed'); }
  const u = await prisma.user.findFirst({ where: { id: maker.userId, clientId: maker.clientId, status: 'ACTIVE', deletedAt: null }, select: USER_SELECT });
  if (!u) throw refuse('no longer staff');
  return toActor(u);
}

const mayOpen = (a: Actor) => holdsEverything(a) || may(a, PERMISSIONS.CLOSE_DAY) || may(a, PERMISSIONS.SETTINGS);

const normalisePhone = (s: string) => {
  const d = s.replace(/\D/g, '');
  return d.length === 10 ? `+91${d}` : d.length === 12 && d.startsWith('91') ? `+${d}` : null;
};

/** Open the till: email or phone + password, owner or manager. */
export async function openTill(input: { login?: string; password?: string; shopId?: string; deviceId?: string }) {
  // Plain text only: an object here would otherwise become a database filter.
  if ([input.login, input.password, input.shopId, input.deviceId].some(v => v !== undefined && typeof v !== 'string')) {
    throw badRequest('Enter your email or phone number, and your password.');
  }
  const login = (input.login ?? '').trim().toLowerCase();
  const password = input.password ?? '';
  if (!login || !password) throw badRequest('Enter your email or phone number, and your password.');

  const phone = normalisePhone(login);
  // One count per ACCOUNT, however the phone number is written (17 Nov audit).
  const attempt = signInLock.begin(`open:${input.shopId ?? '*'}:${phone ?? login}`);
  if (attempt.locked) throw lockedOut(attempt.retryInMs);
  try {
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
  if (candidates.length === 0) await bcrypt.compare(password, NOBODY_HASH);
  if (matching.length === 0) {
    attempt.fail();
    throw unauthorized('That email or phone and password do not match. Check them and try again.', { code: 'BAD_LOGIN' });
  }
  attempt.succeed();

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
    ...withOfflineKey(sign({ typ: 'staff', cid: u.clientId, tid: session.id, sub: u.id }, `${STAFF_HOURS}h`)),
    shop: { name: shop?.shopName ?? 'Your shop' },
    person: { id: u.id, name: u.name }
  };
  } finally {
    attempt.release();   // any other way out gives the reserved try back (no-op after fail/succeed)
  }
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
  // A plain id only: an object here would become a database filter (17 Nov audit).
  const userId = typeof input.userId === 'string' && /^[\w-]{1,64}$/.test(input.userId) ? input.userId : null;
  if (!userId) throw badRequest('Choose your name first.');
  if (typeof input.pin !== 'string' || !/^\d{4,6}$/.test(input.pin)) throw badRequest('Enter your PIN.');
  const pin = input.pin;
  /*
   * The SAME 4-digit PIN that approves a discount is the one that takes the till -- and taking the till
   * gives a whole 12-hour session -- so it gets at least the lockout approvals have: growing, and
   * counted before the compare (17 Nov audit: it was a flat five minutes, and raceable).
   */
  const attempt = signInLock.begin(`pin:${c.cid}:${userId}`);
  if (attempt.locked) throw lockedOut(attempt.retryInMs);
  let u;
  try {
    u = await prisma.user.findFirst({ where: { id: userId, clientId: c.cid, status: 'ACTIVE', deletedAt: null }, select: USER_SELECT });
    if (!u || !u.approvalPinHash) throw notFound('That name is not on this till any more. Choose again.');
    if (!(await bcrypt.compare(pin, u.approvalPinHash))) {
      const lock = attempt.fail();
      // The owner sees somebody guessing a PIN in the activity log, as approval lockouts already are.
      if (lock) {
        void record(systemActor(c.cid), {
          action: 'auth.pin_locked', subject: u.name,
          detail: { userId: u.id, lockedForMinutes: Math.round(lock.lockedForMs / 60_000), lockoutNumber: lock.lockoutNumber }
        });
      }
      throw unauthorized('That PIN is not right. Try again.', { code: 'BAD_PIN' });
    }
    attempt.succeed();
  } finally {
    attempt.release();   // any other way out gives the reserved try back (no-op after fail/succeed)
  }
  return {
    ...withOfflineKey(sign({ typ: 'staff', cid: c.cid, tid: c.tid, sub: u.id }, `${STAFF_HOURS}h`)),
    person: { id: u.id, name: u.name }
  };
}

/** Close the till on this device. Anyone at it may -- closing is always safe. */
export async function closeTill(tillToken: string | undefined, by: Actor | null) {
  const c = readToken(tillToken, 'till');
  // A staff token of some other shop names nobody here, whatever it says.
  const who = by && by.kind === 'USER' && by.clientId === c.cid ? by : null;
  const r = await prisma.tillSession.updateMany({ where: { id: c.tid, clientId: c.cid, closedAt: null }, data: { closedAt: new Date(), closedById: who?.id ?? null } });
  openCache.delete(c.tid);
  /*
   * Recorded, like closing every till is. Closing one is the smaller act but it is the one that
   * actually happens, and an owner asking "why did the counter sign itself out in the middle of
   * trade?" was getting nothing at all: Activity showed six "Till opened" in an afternoon and not
   * one close (6 Oct). A sign-out a person did not expect looks like a fault until the log says
   * who did it.
   */
  if (r.count && who) await record(who, { action: 'till.closed', detail: { everywhere: false } });
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
