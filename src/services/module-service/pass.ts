import { createPublicKey, KeyObject, verify } from 'crypto';
import { readFileSync } from 'fs';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { ensureRoles } from '../shop-setup';
import { forbidden, unauthorized, unavailable } from '../../utils/httpError';
import { askSoon } from './links.service';

/**
 * ANOTHER SCALEEZY MODULE BILLING THROUGH POS (20 Nov; the owner: modules talk only through APIs).
 *
 * The Boutique app (CRM-B) bills retail pieces at its counter through POS, so billing stays POS's: the GST
 * series, payments, returns, store credit, vouchers, points, the drawer and day close. Its staff never open
 * POS; every call carries a short-lived pass the Boutique app signs with its OWN private key, and POS holds
 * only the public half. A leaked public key signs nothing.
 *
 *   header   { alg: 'RS256', kid: BOUTIQUE_KID }
 *   claims   { iss: 'scaleezy-boutique', aud: 'scaleezy-pos', iat, exp (at most 5 minutes later),
 *              tenant: the boutique account, onBehalfOf: { userId, name, can: ['pos:sell', 'pos:manager'?] } }
 *
 * The same app's passes to Inventory say aud 'inventory' and are refused here: a pass is for one module.
 * Which POS shop the tenant is, what it may do and at which counter: the shop's ModuleLink.
 */

import { MODULE, ISS, AUD, SERVICE_SCOPES, ServiceScope } from './constants';
export { MODULE, SERVICE_SCOPES };
export type { ServiceScope };
const MAX_LIFE_S = 300;
const SKEW_S = 60;


let cached: KeyObject | null | undefined;
function publicKey(): KeyObject | null {
  if (cached !== undefined) return cached;
  if (!env.BOUTIQUE_PUBLIC_KEY_PATH || !env.BOUTIQUE_KID) return (cached = null);
  try {
    cached = createPublicKey(readFileSync(env.BOUTIQUE_PUBLIC_KEY_PATH, 'utf8'));
  } catch (e) {
    console.error(`[service] BOUTIQUE_PUBLIC_KEY_PATH is set but the key could not be read: ${(e as Error).message}`);
    cached = null;
  }
  return cached;
}
/** For the tests, which swap keys within one process. */
export const __forgetKey = () => { cached = undefined; };

export const serviceOn = () => !!publicKey();

const b64json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export interface Pass { tenant: string; userId: string; name: string; can: string[] }

/** Checks the pass, every claim, and says plainly what is wrong with one that fails. */
export function readPass(token: string | undefined): Pass {
  const key = publicKey();
  if (!key) throw unavailable('Billing for other ScaleEzy modules is not switched on at POS yet.', { code: 'SERVICE_OFF' });
  if (!token) throw unauthorized('A signed pass is needed.', { code: 'NO_PASS' });
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('That pass is not one POS can read.', { code: 'BAD_PASS' });
  let header: any, claims: any;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { throw unauthorized('That pass is not one POS can read.', { code: 'BAD_PASS' }); }
  // RS256 only, by name: never "none", never a shared-secret algorithm with the public key as the secret.
  if (header?.alg !== 'RS256' || header?.kid !== env.BOUTIQUE_KID) throw unauthorized('That pass was not signed with a key POS knows.', { code: 'BAD_PASS' });
  const good = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!good) throw unauthorized('That pass was not signed with a key POS knows.', { code: 'BAD_PASS' });

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISS || !aud.includes(AUD)) throw unauthorized('That pass is not for POS.', { code: 'WRONG_AUDIENCE' });
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || claims.exp <= now - SKEW_S || claims.iat > now + SKEW_S || claims.exp - claims.iat > MAX_LIFE_S) {
    throw unauthorized('That pass has run out. Send the call again with a new one.', { code: 'PASS_EXPIRED' });
  }
  const who = claims.onBehalfOf ?? {};
  // Inventory keeps boutique accounts in lowercase (20 Nov): compared the same way here.
  const tenant = typeof claims.tenant === 'string' ? claims.tenant.trim().toLowerCase() : '';
  const userId = typeof who.userId === 'string' || typeof who.userId === 'number' ? String(who.userId).trim() : '';
  const name = typeof who.name === 'string' ? who.name.trim().slice(0, 80) : '';
  // Every bill names a person: no pass from "the system" bills anything.
  if (!tenant || !userId || userId === 'system' || !name) throw unauthorized('A pass must name the boutique account and the person billing.', { code: 'NO_PERSON' });
  const can = Array.isArray(who.can) ? who.can.filter((c: unknown): c is string => typeof c === 'string') : [];
  return { tenant, userId, name, can };
}

/**
 * The person on the pass, as a POS user of this shop: made on their first call, renamed when their name
 * changes, and given the shop's own Cashier or Manager role (its permissions are the owner's to set).
 * No password and no PIN, so they can never sign in to the till itself.
 */
async function personHere(clientId: string, pass: Pass, role: 'CASHIER' | 'MANAGER') {
  const externalRef = `${MODULE}:${pass.userId}`;
  const roleIds = await ensureRoles(clientId);
  const user = await prisma.user.upsert({
    where: { clientId_externalRef: { clientId, externalRef } },
    update: { name: pass.name },
    create: { clientId, externalRef, name: pass.name },
    select: { id: true, status: true, deletedAt: true }
  });
  if (user.status !== 'ACTIVE' || user.deletedAt) throw forbidden(`${pass.name} has been stopped from billing at this shop.`, { code: 'PERSON_STOPPED' });
  await prisma.$transaction([
    prisma.userRole.deleteMany({ where: { userId: user.id, roleId: { not: roleIds[role] } } }),
    prisma.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: roleIds[role] } }, update: {}, create: { userId: user.id, roleId: roleIds[role] } })
  ]);
  const perms = await prisma.rolePermission.findMany({ where: { roleId: roleIds[role] }, select: { permission: { select: { key: true } } } });
  return { id: user.id, permissions: [...new Set(perms.map(p => p.permission.key))] };
}

export interface ServiceCall { actor: Actor; link: { id: string; clientId: string; counterId: string; scopes: string[] } }

/** The pass, the shop it is for, and the person: the Actor every POS service function takes. */
export async function serviceCaller(authorization: string | undefined): Promise<ServiceCall> {
  const token = authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : undefined;
  const pass = readPass(token);
  const link = await prisma.moduleLink.findUnique({ where: { module_tenant: { module: MODULE, tenant: pass.tenant } }, select: { id: true, clientId: true, counterId: true, scopes: true, active: true, paused: true } });
  if (!link || !link.active) { askSoon(); throw forbidden('This boutique is not linked to a POS shop yet. If it was linked in Inventory just now, try again in a minute.', { code: 'NOT_LINKED' }); }
  if (link.paused) throw forbidden('The shop owner has paused billing from the Boutique app.', { code: 'PAUSED' });
  // A manager may do what the shop's managers may; anyone else billing is a cashier. Never more: an owner's
  // rights (settings, staff, keys) are not for another app to hold.
  const role = pass.can.includes('pos:manager') ? 'MANAGER' : pass.can.includes('pos:sell') ? 'CASHIER' : null;
  if (!role) throw forbidden(`${pass.name} may not bill at the counter.`, { code: 'NOT_ALLOWED' });
  const person = await personHere(link.clientId, pass, role);
  prisma.moduleLink.update({ where: { id: link.id }, data: { lastCallAt: new Date() } }).catch(() => {});
  return {
    actor: { kind: 'USER', clientId: link.clientId, id: person.id, name: pass.name, roles: [role], permissions: person.permissions },
    link: { id: link.id, clientId: link.clientId, counterId: link.counterId, scopes: link.scopes }
  };
}

/** Refuse a call the shop did not grant this module, naming what is missing. */
export function mustBeGranted(call: ServiceCall, scope: ServiceScope) {
  if (!call.link.scopes.includes(scope)) throw forbidden(`This boutique may not do "${scope}" at this shop.`, { code: 'SCOPE_MISSING', scope });
}
