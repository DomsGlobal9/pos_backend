import { createPrivateKey, KeyObject, sign } from 'crypto';
import { readFileSync } from 'fs';
import { env } from '../../config/env';

/**
 * THE TILL'S OWN SIGNATURE ON ITS CALLS TO CRM (19 Nov, the owner: modules talk only through APIs).
 *
 * CRM's service API (/api/v1/service/...) takes a short-lived token each module signs with its OWN private
 * key; CRM holds only the public half, under the module's name (iss) and key id (kid). A leaked public key
 * signs nothing, and no module can act as another.
 *
 *   header   { alg: 'RS256', typ: 'JWT', kid: POS_SERVICE_KID }
 *   claims   { iss: POS_SERVICE_ISS, aud: 'scaleezy-crm', iat, exp: iat + 5 min, clientId, scope }
 *
 * clientId is the shop as CRM knows it: Inventory's id for it (InventoryLink.platformClientId). A till
 * with no Inventory link has none, and is never linked to CRM.
 */
let cached: KeyObject | null | undefined;
function privateKey(): KeyObject | null {
  if (cached !== undefined) return cached;
  if (!env.POS_SERVICE_PRIVATE_KEY_PATH || !env.POS_SERVICE_KID) return (cached = null);
  try {
    cached = createPrivateKey(readFileSync(env.POS_SERVICE_PRIVATE_KEY_PATH, 'utf8'));
  } catch (e) {
    console.error(`[crm] POS_SERVICE_PRIVATE_KEY_PATH is set but the key could not be read: ${(e as Error).message}`);
    cached = null;
  }
  return cached;
}

/** Whether this till can sign calls to CRM at all (and where CRM is). */
export const canCallCrm = () => Boolean(env.CRM_BASE_URL) && privateKey() !== null;

const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A token for one call, for one shop, asking for these scopes. Lives five minutes. */
export function serviceToken(crmClientId: string, scope: string[], now = Math.floor(Date.now() / 1000)): string {
  const key = privateKey();
  if (!key) throw new Error('This till has no key for CRM (POS_SERVICE_PRIVATE_KEY_PATH, POS_SERVICE_KID).');
  const head = `${part({ alg: 'RS256', typ: 'JWT', kid: env.POS_SERVICE_KID })}.${part({ iss: env.POS_SERVICE_ISS, aud: 'scaleezy-crm', iat: now, exp: now + 300, clientId: crmClientId, scope })}`;
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}

/** For the test scripts only. */
export const __forgetKey = () => { cached = undefined; };
