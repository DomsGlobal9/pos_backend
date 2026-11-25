import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, conflict, forbidden, unavailable } from '../../utils/httpError';
import { record } from '../audit';
import { whatsappConfig, whatsappAccount, platformClientId, forgetAccounts } from './receipt-send.service';

/**
 * LINKING THE SHOP'S OWN WHATSAPP FROM POS (25 Nov, owner): boutique-run shops have no Inventory login, so
 * Inventory → Settings → WhatsApp is no use to them. POS now links the number itself, through the same
 * WhatsApp service and the same shop id (Inventory's platform id), so one number serves POS, Inventory and
 * CRM, and a number linked in either place shows in both.
 *
 *   WHO: anyone signed in at the till, cashiers too (the owner's word, 25 Nov: the owner is often not there).
 *     Whoever scans decides which phone sends the shop's bills, so every link and unlink is in the activity
 *     log with the person's name.
 *   THE QR AND THE CODE are passed straight from the service to the screen: never logged, never stored, and
 *     the answer is marked no-store. The activity log says only that linking started, and how.
 *   HOW OFTEN: a QR lasts about 20 s, so the screen asks for a fresh one about every 18 s while it is shown
 *     (the service's rule). A request for a CODE starts the link from nothing each time, so the screen never
 *     repeats it by itself. Six link requests a minute per shop, and three codes in ten minutes.
 *   ERRORS: one plain sentence each. The service's own words are not passed on.
 */

const LINK_TIMEOUT_MS = 45_000;   // the service tries for up to ~30 s while the engine makes the QR
const CALL_TIMEOUT_MS = 8_000;

const recent = new Map<string, number[]>();      // link requests per shop (any method)
const recentCodes = new Map<string, number[]>(); // code requests per shop
function allowed(map: Map<string, number[]>, key: string, max: number, windowMs: number) {
  const now = Date.now();
  const list = (map.get(key) ?? []).filter(t => now - t < windowMs);
  if (list.length >= max) { map.set(key, list); return false; }
  list.push(now); map.set(key, list);
  return true;
}
export const __resetWhatsAppLimits = () => { recent.clear(); recentCodes.clear(); };

function mayLink(actor: Actor) {
  // Any person at the till (owner, manager or cashier); never a system or another module's pass.
  return actor.kind === 'USER' && may(actor, PERMISSIONS.SELL);
}
function mustLink(actor: Actor) {
  if (!mayLink(actor)) throw forbidden('Sign in at the till to link the shop’s WhatsApp.', { code: 'NOT_PERMITTED' });
}
function mustBeOn() {
  const config = whatsappConfig();
  if (!config) throw conflict('WhatsApp is not switched on for this POS yet. Ask ScaleEzy support.', { code: 'WHATSAPP_OFF' });
  return config;
}
const DOWN = 'WhatsApp could not be reached just now. Try again in a minute.';

/**
 * An Indian mobile number as the service wants it: 91 and ten digits. "98765 43210", "+91 98765-43210" and
 * "098765 43210" all work. Anything else is refused here, before the service is asked.
 */
export function phoneForLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!/^[\d\s\-().+]+$/.test(raw.trim())) return null;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return /^[6-9]\d{9}$/.test(d) ? `91${d}` : null;
}

/** What the screen shows: switched on or not, the shop's number (last digits only) and its state. */
export async function whatsappStatus(actor: Actor, opts: { fresh?: boolean } = {}) {
  const configured = whatsappConfig() !== null;
  return {
    configured,
    mayLink: mayLink(actor),
    sendsAs: await platformClientId(actor.clientId),
    // `fresh` only for someone who may link (the screen polls while linking); everyone else gets the cached one.
    account: configured ? await whatsappAccount(actor.clientId, { fresh: opts.fresh === true && mayLink(actor) }) : null
  };
}

/** Start or continue linking: { method: 'qr' } or { method: 'code', phone }. Answers the QR or the code. */
export async function linkWhatsApp(actor: Actor, input: { method?: unknown; phone?: unknown }) {
  mustLink(actor);
  const config = mustBeOn();
  const method = input.method === 'code' ? 'code' : input.method === 'qr' || input.method === undefined ? 'qr' : null;
  if (!method) throw badRequest('Choose a QR or a code.', { code: 'BAD_METHOD' });
  const phone = method === 'code' ? phoneForLink(input.phone) : null;
  if (method === 'code' && !phone) {
    throw badRequest('That phone number does not look right. Enter the WhatsApp number of the shop’s phone, like 98765 43210.', { code: 'BAD_PHONE' });
  }
  if (!allowed(recent, actor.clientId, 6, 60_000) || (method === 'code' && !allowed(recentCodes, actor.clientId, 3, 10 * 60_000))) {
    throw conflict(method === 'code'
      ? 'Too many codes asked for just now. Wait a few minutes, or link with the QR instead.'
      : 'Too many tries just now. Wait a minute and try again.', { code: 'TOO_MANY' });
  }

  const clientId = await platformClientId(actor.clientId);
  let res: Response;
  try {
    res = await fetch(`${config.url}/v1/accounts/client/${encodeURIComponent(clientId)}/link`, {
      method: 'POST',
      headers: { 'x-module-key': config.key, 'content-type': 'application/json' },
      body: JSON.stringify(method === 'code' ? { method, phone } : { method }),
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS)
    });
  } catch {
    throw unavailable(DOWN, { code: 'WHATSAPP_DOWN' });
  }
  if (res.status === 400) throw badRequest(method === 'code'
    ? 'WhatsApp did not accept that number. Check it is the number WhatsApp runs on, on the shop’s phone.'
    : 'WhatsApp did not accept that just now. Try again.', { code: 'REFUSED' });
  if (res.status === 401 || res.status === 403) throw conflict('This POS may not link this shop’s WhatsApp. Ask ScaleEzy support.', { code: 'NOT_ALLOWED_BY_SERVICE' });
  if (!res.ok) throw unavailable(DOWN, { code: 'WHATSAPP_DOWN' });
  const body: any = await res.json().catch(() => null);
  const status = String(body?.status ?? 'LINKING');
  forgetAccounts();
  // Only that linking started, and how: never the QR or the code.
  if (status !== 'CONNECTED') await record(actor, { action: 'whatsapp.link_started', detail: { method } });
  return {
    status,
    qr: method === 'qr' && typeof body?.qr === 'string' && body.qr.startsWith('data:image/') ? body.qr : null,
    pairingCode: method === 'code' && typeof body?.pairingCode === 'string' ? body.pairingCode : null,
    // How long the screen may show this QR before asking for a fresh one.
    refreshInSeconds: method === 'qr' ? 18 : null
  };
}

/** Unlink the shop's number, for every ScaleEzy app. The screen asks the person to confirm first. */
export async function unlinkWhatsApp(actor: Actor) {
  mustLink(actor);
  const config = mustBeOn();
  const clientId = await platformClientId(actor.clientId);
  let res: Response;
  try {
    res = await fetch(`${config.url}/v1/accounts/client/${encodeURIComponent(clientId)}/disconnect`, {
      method: 'POST', headers: { 'x-module-key': config.key }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
  } catch {
    throw unavailable(DOWN, { code: 'WHATSAPP_DOWN' });
  }
  if (res.status === 401 || res.status === 403) throw conflict('This POS may not unlink this shop’s WhatsApp. Ask ScaleEzy support.', { code: 'NOT_ALLOWED_BY_SERVICE' });
  if (!res.ok && res.status !== 404) throw unavailable(DOWN, { code: 'WHATSAPP_DOWN' });
  forgetAccounts();
  await record(actor, { action: 'whatsapp.unlinked' });
  return whatsappStatus(actor, { fresh: true });
}
