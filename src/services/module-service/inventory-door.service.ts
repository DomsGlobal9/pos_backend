import { createPublicKey, KeyObject, verify } from 'crypto';
import { readFileSync } from 'fs';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from '../../utils/httpError';
import { makeOrJoinShop, makeOrJoinPosOnly, ownerActor, readOwner, setShopSwitch, shopAnswer, freshOwnerLink, emailWelcome } from './counter.service';
import { linkShop } from '../crm/link.service';
import { notify } from '../live/live.service';
import { status as linkStatus } from '../inventory-link/link.service';
import { whatsappAccount, whatsappConfig } from '../receipt-send/receipt-send.service';

/**
 * INVENTORY SETS POS UP FOR A CLIENT (the owner, 25 Nov: "the same flow for our Inventory retailers").
 *
 * Until now a till key was made by hand in Inventory's settings and pasted into POS, and ScaleEzy staff made
 * the POS shop. Now Inventory's super admin switches POS on for a client in Inventory's Platform Console (and
 * the Boutique app, whose whole backend runs on Inventory, can do it for a boutique through Inventory too):
 * Inventory makes the till key and calls POS once. POS makes or joins the shop, connects it, brings the
 * catalogue in, makes the owner's login and a one-time welcome link: the same as the Boutique switch.
 *
 * The call is signed with INVENTORY'S OWN service key, the one CRM already trusts:
 *   header { alg: 'RS256', kid: INVENTORY_KID }
 *   claims { iss: 'scaleezy-inventory', aud: 'scaleezy-pos', iat, exp (5 minutes), clientId: Inventory's shop,
 *            scope: ['pos:setup'], onBehalfOf?: { userId, name } (who pressed it) }
 * POS holds only the public half. A pass made for CRM (aud scaleezy-crm) is refused here.
 */

const ISS = 'scaleezy-inventory';
const AUD = 'scaleezy-pos';
const SCOPE = 'pos:setup';
export const BY_INVENTORY = 'Inventory super admin';

let cached: KeyObject | null | undefined;
function publicKey(): KeyObject | null {
  if (cached !== undefined) return cached;
  if (!env.INVENTORY_PUBLIC_KEY_PATH || !env.INVENTORY_KID) return (cached = null);
  try { cached = createPublicKey(readFileSync(env.INVENTORY_PUBLIC_KEY_PATH, 'utf8')); }
  catch (e) { console.error(`[from-inventory] INVENTORY_PUBLIC_KEY_PATH is set but could not be read: ${(e as Error).message}`); cached = null; }
  return cached;
}
export const __forgetInventoryKey = () => { cached = undefined; };

const b64json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

type InventoryPass = { clientId: string; by: string };

function readInventoryPass(authorization: string | undefined): InventoryPass {
  const key = publicKey();
  if (!key) throw unavailable('Setting POS up from Inventory is not switched on at POS yet.', { code: 'DOOR_OFF' });
  const token = authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('A signed pass from Inventory is needed.', { code: 'NO_PASS' });
  let header: any, claims: any;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { throw unauthorized('That pass is not one POS can read.', { code: 'BAD_PASS' }); }
  // RS256 only, by name: never "none", never a shared-secret algorithm with the public key as the secret.
  if (header?.alg !== 'RS256' || header?.kid !== env.INVENTORY_KID) throw unauthorized('That pass was not signed with a key POS knows.', { code: 'BAD_PASS' });
  if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw unauthorized('That pass was not signed with a key POS knows.', { code: 'BAD_PASS' });
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISS || !aud.includes(AUD)) throw unauthorized('That pass is not for POS.', { code: 'WRONG_AUDIENCE' });
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || claims.exp <= now - 60 || claims.iat > now + 60 || claims.exp - claims.iat > 300) {
    throw unauthorized('That pass has run out. Send the call again with a new one.', { code: 'PASS_EXPIRED' });
  }
  const scope = Array.isArray(claims.scope) ? claims.scope : String(claims.scope ?? '').split(' ');
  if (!scope.includes(SCOPE)) throw forbidden(`That pass does not allow "${SCOPE}".`, { code: 'SCOPE_MISSING' });
  const clientId = typeof claims.clientId === 'string' ? claims.clientId.trim() : '';
  if (!/^[\w.-]{1,80}$/.test(clientId)) throw unauthorized('A pass must name the Inventory shop (clientId).', { code: 'NO_SHOP' });
  const who = typeof claims.onBehalfOf?.name === 'string' && claims.onBehalfOf.name.trim() ? claims.onBehalfOf.name.trim().slice(0, 80) : BY_INVENTORY;
  return { clientId, by: who };
}

/**
 * The POS shop for one platform client, when there is one: linked to that Inventory shop, or (26 Nov) made under
 * the client's id by the Console, POS-only included.
 */
async function posShopOf(platformClientId: string) {
  const viaLink = await prisma.inventoryLink.findFirst({ where: { platformClientId }, orderBy: { connected: 'desc' }, select: { clientId: true } });
  if (viaLink) return viaLink;
  const own = await prisma.shopSettings.findFirst({ where: { OR: [{ platformClientId }, { clientId: platformClientId }] }, select: { clientId: true } });
  return own ?? null;
}

/*
 * ONE-SWITCH ONBOARDING (26 Nov, the owner): the platform Console calls these doors for every client, POS-only
 * included. The body says which modules the client has now, with a version: one not above the last applied is an
 * older message arriving late, and is answered { ignored: true } without changing anything.
 */
type Platform = { version: bigint | null; at: Date | null; modules: string[] | null };
function readPlatform(body: any): Platform {
  const v = body?.version;
  const version = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v)
    : typeof v === 'string' && /^\d{1,18}$/.test(v) ? BigInt(v) : null;
  const modules = Array.isArray(body?.modules)
    ? [...new Set((body.modules as unknown[]).filter((m): m is string => typeof m === 'string').map(m => m.trim().toLowerCase()).filter(m => /^[a-z][a-z0-9-]{0,30}$/.test(m)))].slice(0, 20)
    : null;
  const at = typeof body?.at === 'string' && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at) : null;
  return { version, at, modules };
}
async function isOlder(clientId: string, p: Platform) {
  if (p.version === null) return false;
  const s = await prisma.shopSettings.findUnique({ where: { clientId }, select: { platformVersion: true } });
  return s?.platformVersion != null && p.version <= s.platformVersion;
}
async function remember(clientId: string, platformClientId: string, p: Platform) {
  await prisma.shopSettings.update({
    where: { clientId },
    data: {
      platformClientId,
      ...(p.modules ? { platformModules: p.modules } : {}),
      ...(p.version !== null ? { platformVersion: p.version } : {}),
      platformAt: p.at ?? new Date()
    }
  });
  // A module on or off changes what open screens show (Boutique-run notes, CRM, Inventory's items).
  notify(clientId, 'shop');
}
function sameClient(body: any, pass: InventoryPass) {
  if (typeof body?.clientId === 'string' && body.clientId.trim() && body.clientId.trim() !== pass.clientId) {
    throw forbidden('The body names a different client from the pass. Nothing was changed.', { code: 'CLIENT_MISMATCH' });
  }
}

/**
 * Switch POS on for one Inventory client. Body: { shopName, tillKey, owner: { name, email?, phone? } }.
 * Safe to send again; send it again with a new tillKey when Inventory replaces the key.
 */
export async function enableFromInventory(authorization: string | undefined, body: any) {
  const pass = readInventoryPass(authorization);
  sameClient(body, pass);
  const platform = readPlatform(body);
  const before = await posShopOf(pass.clientId);
  if (before && await isOlder(before.clientId, platform)) return { ignored: true, ...(await shopAnswer(before.clientId)) };
  const owner = readOwner(body);
  const shopName = typeof body?.shopName === 'string' && body.shopName.trim() ? body.shopName.trim() : pass.clientId;

  // POS without Inventory (the Console says so): no till key; items are added in POS. CRM, if on, by the client's id.
  if (platform.modules && !platform.modules.includes('inventory')) {
    const r = await makeOrJoinPosOnly({ clientId: before?.clientId ?? pass.clientId, shopName, owner, by: pass.by });
    const off = await prisma.shopSettings.findUnique({ where: { clientId: r.clientId }, select: { switchedOffAt: true } });
    if (off?.switchedOffAt) await setShopSwitch(r.clientId, false, pass.by);
    await remember(r.clientId, pass.clientId, platform);
    if (platform.modules.includes('crm')) linkShop(r.clientId).catch(e => console.error(`[from-inventory] first CRM link for ${r.clientId}:`, (e as Error).message));
    return shopAnswer(r.clientId, { made: r.made, modules: platform.modules, ownerLinkEmailed: r.ownerMade ? await emailWelcome(r.clientId) : false });
  }

  const tillKey = typeof body?.tillKey === 'string' ? body.tillKey.trim() : '';
  if (tillKey.length < 16) throw badRequest('Send the till key Inventory made for this shop.', { code: 'NO_TILL_KEY' });
  // A POS shop of this id already linked to ANOTHER Inventory shop is never taken over.
  const sameId = await prisma.inventoryLink.findUnique({ where: { clientId: pass.clientId }, select: { platformClientId: true } });
  if (sameId?.platformClientId && sameId.platformClientId !== pass.clientId && !(await posShopOf(pass.clientId))) {
    throw conflict(`A POS shop called ${pass.clientId} belongs to another Inventory shop. Ask ScaleEzy support.`, { code: 'ID_TAKEN' });
  }
  const base = env.INVENTORY_BASE_URL ? `${env.INVENTORY_BASE_URL.replace(/\/+$/, '')}/api/v1/pos/v1` : undefined;
  const { clientId, made, ownerMade } = await makeOrJoinShop({
    inventoryClientId: pass.clientId, shopName,
    tillKey, baseUrl: typeof body?.baseUrl === 'string' ? body.baseUrl : base,
    owner, by: pass.by, idPrefix: '', counterName: 'Counter 1', reconnectExisting: true
  });
  const s = await prisma.shopSettings.findUnique({ where: { clientId }, select: { switchedOffAt: true } });
  if (s?.switchedOffAt) await setShopSwitch(clientId, false, pass.by);
  // An older Inventory sends no modules: the shop is run as before. With them: remembered, and CRM follows them.
  if (platform.modules || platform.version !== null) await remember(clientId, pass.clientId, platform);
  if (platform.modules?.includes('crm')) linkShop(clientId).catch(e => console.error(`[from-inventory] first CRM link for ${clientId}:`, (e as Error).message));
  return shopAnswer(clientId, { made, ...(platform.modules ? { modules: platform.modules } : {}), ownerLinkEmailed: ownerMade ? await emailWelcome(clientId) : false });
}

/**
 * Switch POS off for one client: every till closes now and none opens; everything is kept. Since 26 Nov also the
 * links: Inventory's is closed (nothing sent, nothing pulled) and CRM linking stops (a switched-off shop has no CRM
 * shop). On again: enable, with a fresh till key when Inventory is on.
 */
export async function disableFromInventory(authorization: string | undefined, body: any = {}) {
  const pass = readInventoryPass(authorization);
  sameClient(body, pass);
  const platform = readPlatform(body);
  const shop = await posShopOf(pass.clientId);
  if (!shop) throw notFound('This client has no POS shop.', { code: 'NOT_SET_UP' });
  if (await isOlder(shop.clientId, platform)) return { ignored: true, ...(await shopAnswer(shop.clientId)) };
  const s = await prisma.shopSettings.findUnique({ where: { clientId: shop.clientId }, select: { switchedOffAt: true } });
  if (!s?.switchedOffAt) await setShopSwitch(shop.clientId, true, pass.by);
  await prisma.inventoryLink.updateMany({ where: { clientId: shop.clientId, connected: true }, data: { connected: false } });
  if (platform.modules || platform.version !== null) await remember(shop.clientId, pass.clientId, platform);
  return shopAnswer(shop.clientId, { made: false });
}

/**
 * GET /from-inventory/pos/connection (26 Nov): what the Console shows for POS, line by line, in words.
 * state ok | warn | bad; action, when there is something to do. Read-only.
 */
export async function connectionFromInventory(authorization: string | undefined) {
  const pass = readInventoryPass(authorization);
  const shop = await posShopOf(pass.clientId);
  if (!shop) return { lines: [{ key: 'pos', label: 'POS', state: 'warn', says: 'POS is not set up for this client yet.' }] };
  const clientId = shop.clientId;
  const [settings, answer, lastBill, counters] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { clientId }, select: { switchedOffAt: true, platformModules: true } }),
    shopAnswer(clientId),
    prisma.sale.findFirst({ where: { clientId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, invoiceNo: true } }),
    prisma.counter.count({ where: { clientId, active: true } })
  ]);
  const modules = settings?.platformModules ?? [];
  const link: any = await linkStatus(ownerActor(clientId, 'Console'));
  const when = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null);
  const lines: { key: string; label: string; state: 'ok' | 'warn' | 'bad'; says: string; action?: { label: string; href?: string } }[] = [];

  lines.push(settings?.switchedOffAt
    ? { key: 'on', label: 'POS', state: 'bad', says: `Switched off on ${when(settings.switchedOffAt)}. No till opens.`, action: { label: 'Switch POS on' } }
    : { key: 'on', label: 'POS', state: 'ok', says: `On, at ${answer.posAddress}.` });

  const owner = answer.owner;
  lines.push(!owner
    ? { key: 'owner', label: 'Owner', state: 'bad', says: 'No owner yet.', action: { label: 'Switch POS on with the owner' } }
    : owner.passwordSet
      ? { key: 'owner', label: 'Owner', state: 'ok', says: `${owner.name} signs in with ${owner.signInWith}.` }
      : { key: 'owner', label: 'Owner', state: 'warn', says: `${owner.name} has not chosen a password yet (link sent to ${owner.signInWith}).`, action: { label: 'Send a new link' } });

  const wantsInventory = modules.length ? modules.includes('inventory') : link.mode !== 'STANDALONE';
  lines.push(!wantsInventory
    ? { key: 'till', label: 'Till', state: 'ok', says: `POS only: items are added in POS. ${counters} counter${counters === 1 ? '' : 's'}.` }
    : link.mode === 'CONNECTED'
      ? { key: 'till', label: 'Till', state: 'ok', says: `Linked to Inventory shop ${link.inventoryShop ?? pass.clientId}, items last refreshed ${when(link.catalogueSyncedAt) ?? 'not yet'}. ${counters} counter${counters === 1 ? '' : 's'}.` }
      : { key: 'till', label: 'Till', state: 'bad', says: 'Not linked to Inventory: no items or stock come in.', action: { label: 'Switch POS on again (sends a new till key)' } });

  lines.push(lastBill
    ? { key: 'lastBill', label: 'Last bill', state: 'ok', says: `${lastBill.invoiceNo ?? 'A bill'} on ${when(lastBill.createdAt)}.` }
    : { key: 'lastBill', label: 'Last bill', state: 'warn', says: 'No bill yet.' });

  if (wantsInventory && link.mode === 'CONNECTED') {
    lines.push(link.blocked
      ? { key: 'toInventory', label: 'Sales to Inventory', state: 'bad', says: `Stopped at ${link.blocked.document ?? 'a bill'}: ${link.blocked.message ?? link.blocked.code}`, action: { label: 'Open POS → Inventory link' } }
      : link.waiting > 0
        ? { key: 'toInventory', label: 'Sales to Inventory', state: 'warn', says: `${link.waiting} waiting to send (they go by themselves).` }
        : { key: 'toInventory', label: 'Sales to Inventory', state: 'ok', says: `All sent${link.lastDeliveredAt ? `, last ${when(link.lastDeliveredAt)}` : ''}.` });
  }

  const crmOn = modules.length ? modules.includes('crm') : Boolean(link.crmLink?.on);
  if (crmOn) {
    const c = link.crm ?? {}, cl = link.crmLink ?? {};
    lines.push((c.setAside ?? 0) > 0
      ? { key: 'toCrm', label: 'Customers to CRM', state: 'bad', says: `${c.setAside} could not be taken by CRM.` }
      : (cl.waiting ?? 0) > 0 || (c.waiting ?? 0) > 0
        ? { key: 'toCrm', label: 'Customers to CRM', state: 'warn', says: `${(cl.waiting ?? 0) + (c.waiting ?? 0)} waiting (they go by themselves).` }
        : { key: 'toCrm', label: 'Customers to CRM', state: 'ok', says: `Up to date${cl.lastLinkedAt ? `, last ${when(cl.lastLinkedAt)}` : ''}.` });
    lines.push(cl.eventsOn === false
      ? { key: 'fromCrm', label: 'CRM changes to POS', state: 'warn', says: 'CRM is not set up to tell POS of changes yet.' }
      : { key: 'fromCrm', label: 'CRM changes to POS', state: 'ok', says: cl.lastEventAt ? `Last on ${when(cl.lastEventAt)}.` : 'On; nothing has changed in CRM yet.' });
  }

  if (!whatsappConfig()) lines.push({ key: 'whatsapp', label: 'WhatsApp', state: 'warn', says: 'ScaleEzy WhatsApp is not set up for POS: bills are shared from the cashier\'s phone.' });
  else {
    const wa = await whatsappAccount(clientId, { fresh: true });
    lines.push(!wa
      ? { key: 'whatsapp', label: 'WhatsApp', state: 'warn', says: 'Could not be checked just now.' }
      : wa.status === 'CONNECTED'
        ? { key: 'whatsapp', label: 'WhatsApp', state: 'ok', says: `Connected${wa.phone ? ` (${wa.phone})` : ''}.` }
        : { key: 'whatsapp', label: 'WhatsApp', state: 'warn', says: wa.status === 'NOT_LINKED' ? 'No number linked: the shop links it in POS → Settings → WhatsApp.' : `${wa.status.replace('_', ' ').toLowerCase()}: link it again in POS → Settings → WhatsApp.`, action: { label: 'Open POS → Settings → WhatsApp' } });
  }
  return { lines };
}

export async function statusFromInventory(authorization: string | undefined) {
  const pass = readInventoryPass(authorization);
  const shop = await posShopOf(pass.clientId);
  if (!shop) return { posOn: false, shop: null, owner: null };
  return shopAnswer(shop.clientId);
}

/** A new welcome link for the shop's owner ({ reset: true } when they cannot sign in). */
export async function ownerLinkFromInventory(authorization: string | undefined, body: any) {
  const pass = readInventoryPass(authorization);
  const shop = await posShopOf(pass.clientId);
  if (!shop) throw notFound('This Inventory shop has no POS shop.', { code: 'NOT_SET_UP' });
  const { link: ownerLink, emailed } = await freshOwnerLink(shop.clientId, body?.reset === true, `${pass.by} (Inventory)`);
  return shopAnswer(shop.clientId, { ownerLink, ownerLinkEmailed: emailed });
}
