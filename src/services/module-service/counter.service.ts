import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { Actor, PERMISSIONS } from '../../types/actor';
import { ensureRoles } from '../shop-setup';
import { connect, syncCatalogue, shopOfKey } from '../inventory-link';
import { record } from '../audit';
import { hashPassword } from '../auth';
import { cleanPin, cleanEmail, cleanPhone } from '../staff/staff.service';
import { signFor, hasServiceKey } from '../crm/service-token';
import { badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from '../../utils/httpError';
import { readPass, Pass } from './pass';
import { learnFor, BOUTIQUE_COUNTER } from './links.service';
import { MODULE, MADE_BY_ADMIN } from './constants';
export { MADE_BY_ADMIN };

/**
 * POS FOR A BOUTIQUE, SWITCHED ON BY THE BOUTIQUE SUPER ADMIN (the owner, 25 Nov).
 *
 * Boutiques bill at their counters with OUR POS, at POS's own address, as Inventory's retail shops do. Their
 * whole backend already runs on Inventory, so a boutique's POS is POS connected to that boutique's shop in
 * Inventory. When the Boutique app's super admin switches POS on for a client, that one call does all of it:
 *
 *   1. POS asks Inventory, server to server under POS's own key, for a till key for the client's shop
 *      (the key never passes through the Boutique app);
 *   2. POS makes the client's POS shop (or, when the same Inventory shop already has one, adds the Boutique
 *      counter to it: one shop, one invoice series under one GSTIN), connects it, and the catalogue and the
 *      shop's details follow;
 *   3. the owner gets a POS login (their email or phone) and a one-time welcome link to choose a password
 *      and PIN. From then on it is POS as any shop has it: staff, tills, bills, returns, the day.
 *
 * Switched off: that client's tills close and cannot open; everything is kept; switched on again, all is as
 * it was. A shop that also sells retail on POS is never closed by the boutique switch (only the Boutique
 * counter's calls stop).
 *
 * The Boutique app calls these with its own signed pass (aud scaleezy-pos), tenant = the client, and
 * can: ['pos:admin'] for its super admin.
 */

const WELCOME_DAYS = 7;


export type TillKeyAnswer = { clientId: string; shopName: string; tillKey: string; baseUrl?: string };
export type AskInventory = (tenant: string) => Promise<TillKeyAnswer>;

/**
 * Inventory's side (agreed with the Inventory session): POST {INVENTORY}/api/v1/pos/v1/boutique-till-key,
 * signed by POS (iss scaleezy-pos, aud inventory, tenant). Inventory finds the shop that boutique account is
 * linked to, makes a till key for POS (replacing one it made this way before) and answers
 * { clientId, shopName, tillKey }. A boutique Inventory has no shop for: 404.
 */
const realAsk: AskInventory = async (tenant) => {
  if (!env.INVENTORY_BASE_URL || !hasServiceKey()) throw unavailable('POS cannot reach Inventory to set up a boutique yet. Ask ScaleEzy support.', { code: 'SETUP_OFF' });
  const base = `${env.INVENTORY_BASE_URL.replace(/\/+$/, '')}/api/v1/pos/v1`;
  let res: Response;
  try {
    res = await fetch(`${base}/boutique-till-key`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signFor('inventory', { tenant, sub: 'scaleezy-pos' })}` },
      body: JSON.stringify({ tenant })
    });
  } catch {
    throw unavailable('Inventory could not be reached. Nothing was set up; try again in a minute.', { code: 'INVENTORY_UNREACHABLE' });
  }
  const body: any = await res.json().catch(() => null);
  const d = body?.data ?? {};
  if (res.status === 404) throw badRequest('This boutique is not linked to a ScaleEzy shop yet. Link it to ScaleEzy first, then switch POS on.', { code: 'BOUTIQUE_NOT_LINKED' });
  if (!res.ok || typeof d.tillKey !== 'string' || typeof d.clientId !== 'string') {
    throw unavailable(`Inventory did not give a till key${body?.message ? `: ${String(body.message).slice(0, 160)}` : '.'} Nothing was set up; try again.`, { code: 'INVENTORY_REFUSED' });
  }
  return { clientId: d.clientId, shopName: typeof d.shopName === 'string' && d.shopName.trim() ? d.shopName.trim() : 'Boutique', tillKey: d.tillKey, baseUrl: base };
};
let ask: AskInventory = realAsk;
/** For the tests: a stand-in for Inventory's answer. */
export const useAskInventory = (fn: AskInventory | null) => { ask = fn ?? realAsk; };

/** The Boutique app's super admin, for one client (the pass's tenant). */
function adminPass(authorization: string | undefined): Pass {
  const token = authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : undefined;
  const pass = readPass(token);
  if (!pass.can.includes('pos:admin')) throw forbidden('Only the Boutique app\'s super admin switches POS on or off for a boutique.', { code: 'ADMIN_ONLY' });
  return pass;
}

const ownerActor = (clientId: string, name: string): Actor => ({ kind: 'USER', clientId, id: null, name, roles: ['OWNER'], permissions: Object.values(PERMISSIONS) });
const systemFor = (clientId: string): Actor => ({ kind: 'SYSTEM', clientId, id: null, name: 'Boutique super admin', roles: [], permissions: [] });

/* ---- the owner's welcome: one link, to choose a password and PIN ------------------------------------- */

/*
 * Good while the owner has no password, and only for the owner as they were when it was made: any later
 * change to them (a new link, a reset) ends every earlier link.
 */
function welcomeLink(clientId: string, user: { id: string; updatedAt: Date }) {
  const token = jwt.sign({ typ: 'welcome', cid: clientId, sub: user.id, rv: user.updatedAt.getTime() }, env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: `${WELCOME_DAYS}d`, issuer: 'scaleezy-pos' } as jwt.SignOptions);
  return `${env.FRONTEND_URL.replace(/\/+$/, '')}/welcome#${token}`;
}

async function readWelcome(token: unknown) {
  if (typeof token !== 'string' || !token) throw unauthorized('Open the link you were sent.', { code: 'NO_LINK' });
  let c: any;
  try { c = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'scaleezy-pos' }); }
  catch { throw unauthorized('This link has run out. Ask for a new one.', { code: 'LINK_EXPIRED' }); }
  if (c?.typ !== 'welcome' || !c.cid || !c.sub) throw unauthorized('This is not a POS welcome link.', { code: 'NO_LINK' });
  const user = await prisma.user.findFirst({ where: { id: c.sub, clientId: c.cid, status: 'ACTIVE', deletedAt: null }, select: { id: true, name: true, email: true, phone: true, passwordHash: true, updatedAt: true } });
  if (!user) throw unauthorized('This link is no longer good. Ask for a new one.', { code: 'LINK_REPLACED' });
  // Used first: setting the password changes the person, so "replaced" would otherwise hide "used".
  if (user.passwordHash) throw conflict('This link has been used: the password is set. Sign in at the POS.', { code: 'LINK_USED' });
  if (user.updatedAt.getTime() !== c.rv) throw unauthorized('This link is no longer good. Ask for a new one.', { code: 'LINK_REPLACED' });
  return { clientId: c.cid as string, user };
}

/** The welcome screen's details: whose shop, who is setting up, and what they will sign in with. */
export async function welcomeInfo(token: unknown) {
  const { clientId, user } = await readWelcome(token);
  const shop = await prisma.shopSettings.findUnique({ where: { clientId }, select: { shopName: true } });
  return { shop: { id: clientId, name: shop?.shopName ?? 'Your shop' }, name: user.name, signInWith: user.email ?? user.phone };
}

/** The owner chooses a password and PIN; the link is then used up. */
export async function welcomeSet(token: unknown, input: { password?: unknown; pin?: unknown }) {
  const { clientId, user } = await readWelcome(token);
  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length < 8) throw badRequest('Use a password of at least 8 characters.', { code: 'WEAK_PASSWORD' });
  let pin: string;
  try { pin = cleanPin(typeof input.pin === 'string' ? input.pin : ''); } catch (e) { throw badRequest((e as Error).message, { code: 'BAD_PIN' }); }
  // Guarded: only while no password is set, so two presses (or two tabs) cannot both set one.
  const done = await prisma.user.updateMany({
    where: { id: user.id, clientId, passwordHash: null },
    data: { passwordHash: await hashPassword(password), approvalPinHash: await bcrypt.hash(pin, 10) }
  });
  if (done.count !== 1) throw conflict('This link has been used: the password is set. Sign in at the POS.', { code: 'LINK_USED' });
  await record({ kind: 'USER', clientId, id: user.id, name: user.name, roles: ['OWNER'], permissions: [] }, { action: 'staff.changed', subject: user.name ?? 'Owner', detail: { changed: ['password', 'pin'], by: 'welcome link' } });
  return { shopId: clientId, signInWith: user.email ?? user.phone };
}

/* ---- the super admin's switch ------------------------------------------------------------------------ */

async function ownerOf(clientId: string) {
  return prisma.user.findFirst({
    where: { clientId, deletedAt: null, roles: { some: { role: { name: 'OWNER' } } } },
    orderBy: { createdAt: 'asc' }, select: { id: true, name: true, email: true, phone: true, passwordHash: true, updatedAt: true }
  });
}

/* ---- shared by both doors: the Boutique super admin's switch and Inventory's (25 Nov) ---------------- */

export type OwnerIn = { name: string; email: string | null; phone: string | null };

/** The owner's details from a switch-on body; null when none were sent. */
export function readOwner(body: { owner?: { name?: unknown; email?: unknown; phone?: unknown } } | undefined): OwnerIn | null {
  const o = body?.owner;
  if (!o) return null;
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '';
  let email: string | null = null, phone: string | null = null;
  try {
    email = cleanEmail(typeof o.email === 'string' ? o.email : null);
    phone = cleanPhone(typeof o.phone === 'string' ? o.phone : null);
  } catch (e) { throw badRequest(`Owner: ${(e as Error).message}`, { code: 'BAD_OWNER' }); }
  if (name.length < 2 || (!email && !phone)) throw badRequest('Send the owner\'s name, and their email or phone: they sign in to POS with it.', { code: 'OWNER_NEEDED' });
  return { name, email, phone };
}

/**
 * The POS shop for one Inventory shop: the one already connected to it (a shop on POS before, made by hand
 * or by an earlier switch-on: joined, never a second, so one invoice series per GSTIN), or a new one.
 * A new shop gets the owner (needed), is connected with the till key (tried against Inventory first), knows
 * which Inventory shop it is at once, and has its catalogue and shop details now, not at the next refresh.
 */
export async function makeOrJoinShop(input: {
  inventoryClientId: string; shopName: string; tillKey: string; baseUrl?: string;
  owner: OwnerIn | null; by: string; idPrefix: string; counterName: string; reconnectExisting: boolean;
}) {
  // The key must open the very Inventory shop named: a mix-up on the other side never connects the wrong shop.
  const base = input.baseUrl ?? (env.INVENTORY_BASE_URL ? `${env.INVENTORY_BASE_URL.replace(/\/+$/, '')}/api/v1/pos/v1` : '');
  if (!/^https?:\/\/\S+$/.test(base)) throw unavailable('POS has no Inventory address set. Ask ScaleEzy support. Nothing was set up.', { code: 'NO_ADDRESS' });
  const opens = await shopOfKey(base, input.tillKey);
  if (opens.clientId && opens.clientId !== input.inventoryClientId) {
    throw conflict(`That till key opens Inventory shop ${opens.clientId}, not ${input.inventoryClientId}. Nothing was set up.`, { code: 'KEY_FOR_ANOTHER_SHOP' });
  }
  const existing = await prisma.inventoryLink.findFirst({ where: { platformClientId: input.inventoryClientId }, orderBy: { connected: 'desc' }, select: { clientId: true, connected: true } });
  const clientId = existing?.clientId ?? `${input.idPrefix}${input.inventoryClientId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  const made = !existing && !(await prisma.shopSettings.findUnique({ where: { clientId }, select: { clientId: true } }));
  const actor = ownerActor(clientId, input.by);

  // A shop with nobody to sign in (new, or its owner gone) needs the owner's details, before anything is made.
  if (!input.owner && (made || !(await ownerOf(clientId)))) throw badRequest('Send the owner\'s name, and their email or phone: they sign in to POS with it.', { code: 'OWNER_NEEDED' });
  if (made) {
    const roleIds = await ensureRoles(clientId);
    await prisma.$transaction(async tx => {
      // A new shop's own settings (as shop-setup makes them); Inventory's shop details then fill name, address and GSTIN.
      await tx.shopSettings.create({
        data: {
          clientId, shopName: input.shopName.slice(0, 80), receiptFooter: 'Thank you for shopping with us.', invoicePrefix: 'INV', creditNotePrefix: 'CN',
          enabledPaymentMethods: ['CASH', 'UPI', 'CARD'], manualDiscountMaxPercent: 10, returnWindowDays: 7, holdThresholdQty: 3
        }
      });
      await tx.counter.create({ data: { clientId, name: input.counterName } });
      await tx.user.create({ data: { clientId, name: input.owner!.name, email: input.owner!.email, phone: input.owner!.phone, roles: { create: { roleId: roleIds.OWNER } } } });
    });
  } else if (!(await ownerOf(clientId)) && input.owner) {
    const roleIds = await ensureRoles(clientId);
    await prisma.user.create({ data: { clientId, name: input.owner.name, email: input.owner.email, phone: input.owner.phone, roles: { create: { roleId: roleIds.OWNER } } } });
  }

  if (made || !existing?.connected || input.reconnectExisting) {
    await connect(actor, { key: input.tillKey, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) });
    await prisma.inventoryLink.update({ where: { clientId }, data: { platformClientId: input.inventoryClientId } });
    await syncCatalogue(actor, { full: true }).catch(e => console.error(`[pos-setup] first catalogue for ${clientId}:`, (e as Error).message));
  }
  return { clientId, made };
}

/** POS switched off (or on) for a whole shop: off closes every till now; sign-in refuses while off. */
export async function setShopSwitch(clientId: string, off: boolean, by: string) {
  const now = new Date();
  await prisma.shopSettings.update({ where: { clientId }, data: off ? { switchedOffAt: now, switchedOffBy: by } : { switchedOffAt: null, switchedOffBy: null } });
  if (off) await prisma.tillSession.updateMany({ where: { clientId, closedAt: null }, data: { closedAt: now } });
  await record(systemFor(clientId), { action: 'module.changed', subject: clientId, detail: { pos: off ? 'switched off' : 'switched on', by } });
}

/** A new welcome link for a shop's owner; { reset } takes their password away first. Ends every earlier link. */
export async function freshOwnerLink(clientId: string, reset: boolean, by: string) {
  let owner = await ownerOf(clientId);
  if (!owner) throw notFound('This POS shop has no owner yet. Switch POS on again with the owner\'s details.', { code: 'NO_OWNER' });
  if (owner.passwordHash) {
    if (!reset) throw conflict('The owner has chosen a password already. Send { reset: true } to take it away and send a new link.', { code: 'PASSWORD_SET' });
    await prisma.user.update({ where: { id: owner.id }, data: { passwordHash: null } });
    await prisma.tillSession.updateMany({ where: { clientId, openedById: owner.id, closedAt: null }, data: { closedAt: new Date() } });
    await record(systemFor(clientId), { action: 'staff.changed', subject: owner.name ?? 'Owner', detail: { changed: ['password'], by, reset: true } });
  } else {
    await prisma.user.update({ where: { id: owner.id }, data: { updatedAt: new Date() } });
  }
  owner = (await ownerOf(clientId))!;
  return welcomeLink(clientId, owner);
}

/** What a switch answers: the shop, whether POS is on, the owner, and (when they have no password) their link. */
export async function shopAnswer(clientId: string, extra: Record<string, unknown> = {}) {
  const [shop, link, owner] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { clientId }, select: { shopName: true, switchedOffAt: true } }),
    prisma.moduleLink.findUnique({ where: { clientId_module: { clientId, module: MODULE } }, select: { active: true, paused: true, disabledAt: true, createdBy: true, counter: { select: { name: true } } } }),
    ownerOf(clientId)
  ]);
  return {
    posOn: !shop?.switchedOffAt,
    shop: { id: clientId, name: shop?.shopName ?? 'Shop' },
    boutique: link ? { linked: link.active, on: link.active && !link.disabledAt, counter: link.counter.name, pausedByOwner: link.paused, madeForBoutique: link.createdBy === MADE_BY_ADMIN } : null,
    posAddress: env.FRONTEND_URL.replace(/\/+$/, ''),
    owner: owner ? { name: owner.name, signInWith: owner.email ?? owner.phone, passwordSet: !!owner.passwordHash } : null,
    ownerLink: owner && !owner.passwordHash && !shop?.switchedOffAt ? welcomeLink(clientId, owner) : null,
    ...extra
  };
}

/* ---- the Boutique super admin's switch --------------------------------------------------------------- */

/**
 * Switch POS on for one boutique client. Safe to send again: what exists is answered, nothing made twice.
 * Body: { owner: { name, email?, phone? } }, needed the first time for a shop made for the boutique.
 */
export async function enableForBoutique(authorization: string | undefined, body: { owner?: { name?: unknown; email?: unknown; phone?: unknown } }) {
  const pass = adminPass(authorization);
  const owner = readOwner(body);

  // Switched on before: switched on again, as it was.
  const known = await prisma.moduleLink.findUnique({ where: { module_tenant: { module: MODULE, tenant: pass.tenant } }, select: { id: true, clientId: true, active: true, disabledAt: true, createdBy: true } });
  if (known?.active) {
    if (known.disabledAt) {
      await prisma.moduleLink.update({ where: { id: known.id }, data: { disabledAt: null } });
      const shop = await prisma.shopSettings.findUnique({ where: { clientId: known.clientId }, select: { switchedOffBy: true } });
      // A shop made for the boutique and switched off by the Boutique switch comes back on; one Inventory switched off stays off.
      if (known.createdBy === MADE_BY_ADMIN && shop?.switchedOffBy === BY_BOUTIQUE) await setShopSwitch(known.clientId, false, `${pass.name} (Boutique super admin)`);
    }
    return shopAnswer(known.clientId, { made: false, enabled: true });
  }

  const inv = await ask(pass.tenant);
  const { clientId, made } = await makeOrJoinShop({
    inventoryClientId: inv.clientId, shopName: inv.shopName, tillKey: inv.tillKey, baseUrl: inv.baseUrl,
    owner, by: pass.name, idPrefix: 'btq-', counterName: BOUTIQUE_COUNTER, reconnectExisting: false
  });
  const learned = await learnFor(clientId);
  if (learned !== 'LINKED' && learned !== 'UNCHANGED') {
    throw unavailable('Inventory did not confirm this boutique for the POS shop. Try again in a minute.', { code: 'NOT_CONFIRMED' });
  }
  await prisma.moduleLink.update({ where: { clientId_module: { clientId, module: MODULE } }, data: { disabledAt: null, ...(made ? { createdBy: MADE_BY_ADMIN } : {}) } });
  await record(systemFor(clientId), { action: 'module.linked', subject: pass.tenant, detail: { module: MODULE, by: pass.name, madeShop: made } });
  return shopAnswer(clientId, { made, enabled: true });
}

export const BY_BOUTIQUE = 'Boutique super admin';

/**
 * Switch POS off for one boutique client. A shop made for the boutique: every till closes now and none can
 * open. A shop that also sells retail: only the Boutique counter's calls stop. Everything is kept.
 */
export async function disableForBoutique(authorization: string | undefined) {
  const pass = adminPass(authorization);
  const link = await prisma.moduleLink.findUnique({ where: { module_tenant: { module: MODULE, tenant: pass.tenant } }, select: { id: true, clientId: true, createdBy: true, disabledAt: true } });
  if (!link) throw notFound('POS was never switched on for this boutique.', { code: 'NOT_SET_UP' });
  if (!link.disabledAt) {
    await prisma.moduleLink.update({ where: { id: link.id }, data: { disabledAt: new Date() } });
    if (link.createdBy === MADE_BY_ADMIN) await setShopSwitch(link.clientId, true, BY_BOUTIQUE);
    else await record(systemFor(link.clientId), { action: 'module.changed', subject: pass.tenant, detail: { module: MODULE, by: pass.name, switchedOff: true } });
  }
  return shopAnswer(link.clientId, { made: false, enabled: false });
}

/** Where things stand for one boutique client. */
export async function boutiqueAdminStatus(authorization: string | undefined) {
  const pass = adminPass(authorization);
  const link = await prisma.moduleLink.findUnique({ where: { module_tenant: { module: MODULE, tenant: pass.tenant } }, select: { clientId: true, active: true, disabledAt: true } });
  if (!link) return { enabled: false, shop: null, owner: null };
  return shopAnswer(link.clientId, { enabled: link.active && !link.disabledAt });
}

/**
 * A new welcome link for the owner: when theirs ran out, or (reset: true) when they cannot sign in. A reset
 * takes their password away until they choose a new one, and ends every earlier link. Only for a shop made
 * for the boutique: another shop's owner is its own.
 */
export async function newOwnerLink(authorization: string | undefined, body: { reset?: unknown }) {
  const pass = adminPass(authorization);
  const link = await prisma.moduleLink.findUnique({ where: { module_tenant: { module: MODULE, tenant: pass.tenant } }, select: { clientId: true, createdBy: true } });
  if (!link) throw notFound('POS was never switched on for this boutique.', { code: 'NOT_SET_UP' });
  if (link.createdBy !== MADE_BY_ADMIN) throw forbidden('This shop\'s owner signs in to POS as before; their own staff screen changes passwords.', { code: 'NOT_MADE_HERE' });
  const ownerLink = await freshOwnerLink(link.clientId, body?.reset === true, `${pass.name} (Boutique super admin)`);
  return shopAnswer(link.clientId, { ownerLink });
}
