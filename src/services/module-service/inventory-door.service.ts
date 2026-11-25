import { createPublicKey, KeyObject, verify } from 'crypto';
import { readFileSync } from 'fs';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from '../../utils/httpError';
import { makeOrJoinShop, readOwner, setShopSwitch, shopAnswer, freshOwnerLink } from './counter.service';

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

/** The POS shop for one Inventory shop, when there is one. */
async function posShopOf(inventoryClientId: string) {
  return prisma.inventoryLink.findFirst({ where: { platformClientId: inventoryClientId }, orderBy: { connected: 'desc' }, select: { clientId: true } });
}

/**
 * Switch POS on for one Inventory client. Body: { shopName, tillKey, owner: { name, email?, phone? } }.
 * Safe to send again; send it again with a new tillKey when Inventory replaces the key.
 */
export async function enableFromInventory(authorization: string | undefined, body: any) {
  const pass = readInventoryPass(authorization);
  const tillKey = typeof body?.tillKey === 'string' ? body.tillKey.trim() : '';
  if (tillKey.length < 16) throw badRequest('Send the till key Inventory made for this shop.', { code: 'NO_TILL_KEY' });
  const owner = readOwner(body);
  // A POS shop of this id already linked to ANOTHER Inventory shop is never taken over.
  const sameId = await prisma.inventoryLink.findUnique({ where: { clientId: pass.clientId }, select: { platformClientId: true } });
  if (sameId?.platformClientId && sameId.platformClientId !== pass.clientId && !(await posShopOf(pass.clientId))) {
    throw conflict(`A POS shop called ${pass.clientId} belongs to another Inventory shop. Ask ScaleEzy support.`, { code: 'ID_TAKEN' });
  }
  const base = env.INVENTORY_BASE_URL ? `${env.INVENTORY_BASE_URL.replace(/\/+$/, '')}/api/v1/pos/v1` : undefined;
  const { clientId, made } = await makeOrJoinShop({
    inventoryClientId: pass.clientId, shopName: typeof body?.shopName === 'string' && body.shopName.trim() ? body.shopName.trim() : pass.clientId,
    tillKey, baseUrl: typeof body?.baseUrl === 'string' ? body.baseUrl : base,
    owner, by: pass.by, idPrefix: '', counterName: 'Counter 1', reconnectExisting: true
  });
  const s = await prisma.shopSettings.findUnique({ where: { clientId }, select: { switchedOffAt: true } });
  if (s?.switchedOffAt) await setShopSwitch(clientId, false, pass.by);
  return shopAnswer(clientId, { made });
}

/** Switch POS off for one Inventory client: every till closes now and none opens. Everything is kept. */
export async function disableFromInventory(authorization: string | undefined) {
  const pass = readInventoryPass(authorization);
  const shop = await posShopOf(pass.clientId);
  if (!shop) throw notFound('This Inventory shop has no POS shop.', { code: 'NOT_SET_UP' });
  const s = await prisma.shopSettings.findUnique({ where: { clientId: shop.clientId }, select: { switchedOffAt: true } });
  if (!s?.switchedOffAt) await setShopSwitch(shop.clientId, true, BY_INVENTORY);
  return shopAnswer(shop.clientId, { made: false });
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
  const ownerLink = await freshOwnerLink(shop.clientId, body?.reset === true, `${pass.by} (Inventory)`);
  return shopAnswer(shop.clientId, { ownerLink });
}
