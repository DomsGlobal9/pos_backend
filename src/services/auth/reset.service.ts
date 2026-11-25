import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { mailConfigured, sendReset, sendPasswordChanged } from '../../lib/mailer';
import { hashPassword } from './auth.service';
import { record } from '../audit';
import { badRequest, conflict, unauthorized } from '../../utils/httpError';

/**
 * "FORGOT YOUR PASSWORD?" BY EMAIL (25 Nov): the owner or a manager gets a link themselves; nobody at ScaleEzy has
 * to be online. Kept within limits:
 *
 *   one answer for all: whether or not the email belongs to anyone, the screen says the same, so it cannot be
 *     used to find out who has a login;
 *   a link works ONCE, for 30 MINUTES; a newer link ends the older ones; changing the password ends them all;
 *   at most 3 links an hour per email, and one a minute; the route also limits each address;
 *   only people who sign in with a password (owners, managers); never someone billing through the Boutique app
 *     (their app is their sign-in); never a shop ScaleEzy switched off;
 *   after a change, a "your password was changed" email, so a change nobody asked for does not go unseen;
 *   everything in the activity log.
 *
 * Staff, PINs, bills and settings are untouched: only that person's password changes, and no till closes.
 */

const MINUTES = 30;
const PER_HOUR = 3;
const GAP_MS = 60_000;
const sentAt = new Map<string, number[]>();   // per email; POS runs as one instance (checked 19 Nov)

/** POS's own web address for links: the first of FRONTEND_URL, as receipts use it. */
const posAddress = () => (process.env.PUBLIC_RECEIPT_BASE_URL || env.FRONTEND_URL.split(',')[0]).trim().replace(/\/+$/, '');

export const RESET_ANSWER = 'If that email signs in to a POS shop as an owner or manager, a link to choose a new password is on its way. It works once, for 30 minutes. Check your spam folder too.';

/** Too many asks for this email just now? Counts the ask only when it is allowed. */
function allowed(email: string) {
  const now = Date.now();
  const recent = (sentAt.get(email) ?? []).filter(t => now - t < 3_600_000);
  if (recent.length >= PER_HOUR || (recent.length && now - recent[recent.length - 1] < GAP_MS)) { sentAt.set(email, recent); return false; }
  recent.push(now); sentAt.set(email, recent);
  return true;
}
export const __resetLimits = () => sentAt.clear();

/** Ask for a link. Always the same answer; the email goes only where it should. */
export async function requestReset(input: { email?: unknown }) {
  if (!mailConfigured()) throw conflict('Email is not set up on this POS yet, so a link cannot be sent. Use one of the other ways below, or ask ScaleEzy support.', { code: 'MAIL_OFF' });
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw badRequest('Enter the email you sign in with.', { code: 'BAD_EMAIL' });
  if (!allowed(email)) return { message: RESET_ANSWER };   // the same answer: a limit says nothing about the account

  const people = await prisma.user.findMany({
    where: {
      email, status: 'ACTIVE', deletedAt: null, externalRef: null,
      roles: { some: { role: { name: { in: ['OWNER', 'MANAGER'] } } } }
    },
    select: { id: true, clientId: true, name: true, updatedAt: true }
  });
  const shops = await prisma.shopSettings.findMany({ where: { clientId: { in: people.map(p => p.clientId) }, switchedOffAt: null }, select: { clientId: true, shopName: true } });
  const open = new Map(shops.map(s => [s.clientId, s.shopName]));
  const links: { name: string; link: string }[] = [];
  for (const p of people.filter(x => open.has(x.clientId))) {
    // A fresh link ends the older ones: the person's updatedAt is part of every link.
    const u = await prisma.user.update({ where: { id: p.id }, data: { updatedAt: new Date() }, select: { updatedAt: true } });
    const token = jwt.sign({ typ: 'reset', cid: p.clientId, sub: p.id, rv: u.updatedAt.getTime() }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: `${MINUTES}m`, issuer: 'scaleezy-pos' } as jwt.SignOptions);
    links.push({ name: open.get(p.clientId)!, link: `${posAddress()}/reset#${token}` });
    await record({ kind: 'SYSTEM', clientId: p.clientId, id: null, name: 'Forgot password', roles: [], permissions: [] }, { action: 'staff.changed', subject: p.name ?? 'Staff', detail: { resetLinkSent: true } });
  }
  if (links.length) await sendReset(email, { name: people[0].name ?? 'there', shops: links, minutes: MINUTES });
  return { message: RESET_ANSWER };
}

async function readReset(token: unknown) {
  if (typeof token !== 'string' || !token) throw unauthorized('Open the link from your email.', { code: 'NO_LINK' });
  let c: any;
  try { c = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'scaleezy-pos' }); }
  catch { throw unauthorized('This link has run out (links work for 30 minutes). Ask for a new one.', { code: 'LINK_EXPIRED' }); }
  if (c?.typ !== 'reset' || !c.cid || !c.sub) throw unauthorized('This is not a POS password link.', { code: 'NO_LINK' });
  const user = await prisma.user.findFirst({ where: { id: c.sub, clientId: c.cid, status: 'ACTIVE', deletedAt: null, externalRef: null }, select: { id: true, name: true, email: true, phone: true, updatedAt: true } });
  if (!user || user.updatedAt.getTime() !== c.rv) throw unauthorized('This link has been used, or a newer one was sent. Use the newest email, or ask for a new link.', { code: 'LINK_REPLACED' });
  const shop = await prisma.shopSettings.findUnique({ where: { clientId: c.cid }, select: { shopName: true, switchedOffAt: true } });
  if (shop?.switchedOffAt) throw conflict('POS is switched off for this shop. Ask ScaleEzy support.', { code: 'SWITCHED_OFF' });
  return { clientId: c.cid as string, user, shopName: shop?.shopName ?? 'Your shop' };
}

/** The reset screen's details: whose shop, and what they sign in with. */
export async function resetInfo(token: unknown) {
  const { clientId, user, shopName } = await readReset(token);
  return { shop: { id: clientId, name: shopName }, name: user.name, signInWith: user.email ?? user.phone };
}

/** The new password. The link is then used up (the person changes, so every link to them ends). */
export async function resetSet(token: unknown, input: { password?: unknown }) {
  const { clientId, user, shopName } = await readReset(token);
  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length < 8) throw badRequest('Use a password of at least 8 characters.', { code: 'WEAK_PASSWORD' });
  const done = await prisma.user.updateMany({ where: { id: user.id, clientId, updatedAt: user.updatedAt }, data: { passwordHash: await hashPassword(password) } });
  if (done.count !== 1) throw unauthorized('This link has been used already. Sign in with your new password.', { code: 'LINK_REPLACED' });
  await record({ kind: 'USER', clientId, id: user.id, name: user.name, roles: [], permissions: [] }, { action: 'staff.changed', subject: user.name ?? 'Staff', detail: { changed: ['password'], by: 'email link' } });
  if (user.email) await sendPasswordChanged(user.email, { name: user.name ?? 'there', shop: shopName });
  return { shopId: clientId, signInWith: user.email ?? user.phone };
}
