import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { Actor, PERMISSIONS } from '../../types/actor';
import { ensureRoles } from '../shop-setup';
import { connect, syncCatalogue } from '../inventory-link';
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

/** The POS shop id for a boutique's Inventory shop: its own, so it is never confused with a retail shop. */
const shopIdFor = (inventoryClientId: string) => `btq-${inventoryClientId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);

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

async function answer(clientId: string, extra: Record<string, unknown> = {}) {
  const [shop, link, owner] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { clientId }, select: { shopName: true } }),
    prisma.moduleLink.findUnique({ where: { clientId_module: { clientId, module: MODULE } }, select: { active: true, paused: true, disabledAt: true, createdBy: true, counter: { select: { name: true } } } }),
    ownerOf(clientId)
  ]);
  return {
    enabled: !!link?.active && !link.disabledAt,
    shop: { id: clientId, name: shop?.shopName ?? 'Boutique', madeForBoutique: link?.createdBy === MADE_BY_ADMIN },
    counter: link?.counter.name ?? null,
    pausedByOwner: !!link?.paused,
    posAddress: env.FRONTEND_URL.replace(/\/+$/, ''),
    owner: owner ? { name: owner.name, signInWith: owner.email ?? owner.phone, passwordSet: !!owner.passwordHash } : null,
    ...extra
  };
}

/**
 * Switch POS on for one boutique client. Safe to send again: what exists is answered, nothing made twice.
 * Body: { owner: { name, email?, phone? } }, needed the first time for a shop made for the boutique.
 */
export async function enableForBoutique(authorization: string | undefined, body: { owner?: { name?: unknown; email?: unknown; phone?: unknown } }) {
  const pass = adminPass(authorization);

  // Switched on before: switched on again, as it was.
  const known = await prisma.moduleLink.findUnique({ where: { module_tenant: { module: MODULE, tenant: pass.tenant } }, select: { id: true, clientId: true, active: true, disabledAt: true } });
  if (known?.active) {
    if (known.disabledAt) {
      await prisma.moduleLink.update({ where: { id: known.id }, data: { disabledAt: null } });
      await record(systemFor(known.clientId), { action: 'module.changed', subject: pass.tenant, detail: { module: MODULE, by: pass.name, switchedOn: true } });
    }
    const owner = await ownerOf(known.clientId);
    return answer(known.clientId, { made: false, ownerLink: owner && !owner.passwordHash ? welcomeLink(known.clientId, owner) : null });
  }

  const inv = await ask(pass.tenant);
  // The same Inventory shop already on POS (it sells retail on our till too): the Boutique counter joins it.
  const existing = await prisma.inventoryLink.findFirst({ where: { platformClientId: inv.clientId, connected: true }, select: { clientId: true } });
  const clientId = existing?.clientId ?? shopIdFor(inv.clientId);
  const madeHere = !existing;

  let ownerIn: { name: string; email: string | null; phone: string | null } | null = null;
  if (madeHere && !(await ownerOf(clientId))) {
    const name = typeof body?.owner?.name === 'string' ? body.owner.name.trim().slice(0, 60) : '';
    let email: string | null = null, phone: string | null = null;
    try {
      email = cleanEmail(typeof body?.owner?.email === 'string' ? body.owner.email : null);
      phone = cleanPhone(typeof body?.owner?.phone === 'string' ? body.owner.phone : null);
    } catch (e) { throw badRequest(`Owner: ${(e as Error).message}`, { code: 'BAD_OWNER' }); }
    if (name.length < 2 || (!email && !phone)) throw badRequest('Send the owner\'s name, and their email or phone: they sign in to POS with it.', { code: 'OWNER_NEEDED' });
    // An email or phone already signing in to another POS shop would make that sign-in ask which shop: allowed, as for any owner of two shops.
    ownerIn = { name, email, phone };
  }

  if (madeHere && !(await prisma.shopSettings.findUnique({ where: { clientId }, select: { clientId: true } }))) {
    const roleIds = await ensureRoles(clientId);
    await prisma.$transaction(async tx => {
      // A new shop's own settings (as shop-setup makes them); Inventory's shop details then fill name, address and GSTIN.
      await tx.shopSettings.create({
        data: {
          clientId, shopName: inv.shopName.slice(0, 80), receiptFooter: 'Thank you for shopping with us.', invoicePrefix: 'INV', creditNotePrefix: 'CN',
          enabledPaymentMethods: ['CASH', 'UPI', 'CARD'], manualDiscountMaxPercent: 10, returnWindowDays: 7, holdThresholdQty: 3
        }
      });
      await tx.counter.create({ data: { clientId, name: BOUTIQUE_COUNTER } });
      if (ownerIn) await tx.user.create({ data: { clientId, name: ownerIn.name, email: ownerIn.email, phone: ownerIn.phone, roles: { create: { roleId: roleIds.OWNER } } } });
    });
  } else if (madeHere && ownerIn) {
    const roleIds = await ensureRoles(clientId);
    await prisma.user.create({ data: { clientId, name: ownerIn.name, email: ownerIn.email, phone: ownerIn.phone, roles: { create: { roleId: roleIds.OWNER } } } });
  }

  // A shop made for the boutique is connected as any shop is: the key is tried against Inventory first.
  if (madeHere) {
    await connect(ownerActor(clientId, pass.name), { key: inv.tillKey, ...(inv.baseUrl ? { baseUrl: inv.baseUrl } : {}) });
    // Which Inventory shop it is, at once (the catalogue would say so only on its next refresh): the
    // "already on POS" check above must find this shop, never make a second one on the same Inventory shop.
    await prisma.inventoryLink.update({ where: { clientId }, data: { platformClientId: inv.clientId } });
    // The boutique's items, prices and shop details now, not at the next refresh: the counter can sell at once.
    await syncCatalogue(ownerActor(clientId, pass.name), { full: true }).catch(e => console.error(`[boutique] first catalogue for ${clientId}:`, (e as Error).message));
  }
  const learned = await learnFor(clientId);
  if (learned !== 'LINKED' && learned !== 'UNCHANGED') {
    throw unavailable('Inventory did not confirm this boutique for the POS shop. Try again in a minute.', { code: 'NOT_CONFIRMED' });
  }
  await prisma.moduleLink.update({ where: { clientId_module: { clientId, module: MODULE } }, data: { disabledAt: null, ...(madeHere ? { createdBy: MADE_BY_ADMIN } : {}) } });
  await record(systemFor(clientId), { action: 'module.linked', subject: pass.tenant, detail: { module: MODULE, by: pass.name, madeShop: madeHere } });
  const owner = await ownerOf(clientId);
  return answer(clientId, { made: madeHere, ownerLink: owner && !owner.passwordHash ? welcomeLink(clientId, owner) : null });
}

/**
 * Switch POS off for one boutique client. A shop made for the boutique: every till closes now and none can
 * open. A shop that also sells retail: only the Boutique counter's calls stop. Everything is kept.
 */
export async function disableForBoutique(authorization: string | undefined) {
  const pass = adminPass(authorization);
  const link = await prisma.moduleLink.findUnique({ where: { module_tenant: { module: MODULE, tenant: pass.tenant } }, select: { id: true, clientId: true, createdBy: true, disabledAt: true } });
  if (!link) throw notFound('POS was never switched on for this boutique.', { code: 'NOT_SET_UP' });
  if (!link.disabledAt) {
    const now = new Date();
    await prisma.moduleLink.update({ where: { id: link.id }, data: { disabledAt: now } });
    if (link.createdBy === MADE_BY_ADMIN) {
      await prisma.tillSession.updateMany({ where: { clientId: link.clientId, closedAt: null }, data: { closedAt: now } });
    }
    await record(systemFor(link.clientId), { action: 'module.changed', subject: pass.tenant, detail: { module: MODULE, by: pass.name, switchedOff: true } });
  }
  return answer(link.clientId, { made: false, ownerLink: null });
}

/** Where things stand for one boutique client. */
export async function boutiqueAdminStatus(authorization: string | undefined) {
  const pass = adminPass(authorization);
  const link = await prisma.moduleLink.findUnique({ where: { module_tenant: { module: MODULE, tenant: pass.tenant } }, select: { clientId: true } });
  if (!link) return { enabled: false, shop: null, owner: null };
  return answer(link.clientId);
}

/**
 * A new welcome link for the owner: when theirs ran out, or (reset: true) when they cannot sign in. A reset
 * takes their password away until they choose a new one, and ends every earlier link.
 */
export async function newOwnerLink(authorization: string | undefined, body: { reset?: unknown }) {
  const pass = adminPass(authorization);
  const link = await prisma.moduleLink.findUnique({ where: { module_tenant: { module: MODULE, tenant: pass.tenant } }, select: { clientId: true, createdBy: true } });
  if (!link) throw notFound('POS was never switched on for this boutique.', { code: 'NOT_SET_UP' });
  if (link.createdBy !== MADE_BY_ADMIN) throw forbidden('This shop\'s owner signs in to POS as before; their own staff screen changes passwords.', { code: 'NOT_MADE_HERE' });
  let owner = await ownerOf(link.clientId);
  if (!owner) throw notFound('This POS shop has no owner yet. Switch POS on again with the owner\'s details.', { code: 'NO_OWNER' });
  if (owner.passwordHash) {
    if (body?.reset !== true) throw conflict('The owner has chosen a password already. Send { reset: true } to take it away and send a new link.', { code: 'PASSWORD_SET' });
    await prisma.user.update({ where: { id: owner.id }, data: { passwordHash: null } });
    await prisma.tillSession.updateMany({ where: { clientId: link.clientId, openedById: owner.id, closedAt: null }, data: { closedAt: new Date() } });
    await record(systemFor(link.clientId), { action: 'staff.changed', subject: owner.name ?? 'Owner', detail: { changed: ['password'], by: `${pass.name} (Boutique super admin)`, reset: true } });
  } else {
    // A fresh link: any earlier one stops working.
    await prisma.user.update({ where: { id: owner.id }, data: { updatedAt: new Date() } });
  }
  owner = (await ownerOf(link.clientId))!;
  return answer(link.clientId, { ownerLink: welcomeLink(link.clientId, owner) });
}

