import { REGISTRATIONS } from './gst-document';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { may, PERMISSIONS } from '../../types/actor';
import { record } from '../audit';
import { gstinProblem, normaliseGstin } from '../../utils/gstin';
import { whatsappConfig, whatsappAccount, platformClientId } from '../receipt-send';

/**
 * What the till needs to know before it can sell: which shop it is, and which counters it has.
 *
 * Asked once when the till loads rather than per sale. It carries no prices and no stock, so it is
 * safe to cache hard in the browser -- which matters, because it is on the path between opening
 * the till and being able to scan.
 */
export async function forTill(actor: Actor) {
  const [settings, counters, link] = await Promise.all([
    prisma.shopSettings.findUnique({
      where: { clientId: actor.clientId },
      select: {
        shopName: true, gstin: true, address: true, logoUrl: true, receiptFooter: true, upiQrEnabled: true, giftVouchers: true,
        enabledPaymentMethods: true, manualDiscountMaxPercent: true, returnWindowDays: true,
        holdThresholdQty: true, upiId: true, gstRegistration: true, phone: true
      }
    }),
    prisma.counter.findMany({
      where: { clientId: actor.clientId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true }
    }),
    prisma.inventoryLink.findUnique({ where: { clientId: actor.clientId }, select: { connected: true } })
  ]);

  if (!settings) throw notFound('This shop is not set up yet.');
  const account = await whatsappAccount(actor.clientId);

  return {
    shop: settings,
    /*
     * Whether THIS shop is connected to Inventory -- its own link, not whether the server knows an
     * Inventory address. The header used to say "Inventory connected" from the server's setting
     * alone, so a shop that had never connected was told it was (sphl, 1 Oct).
     */
    inventoryConnected: link?.connected === true,
    /*
     * Whether this till can send a receipt itself, or whether the cashier sends it from their own
     * WhatsApp instead (Share). Set up AND the shop's number linked (12 Oct: the button used to show
     * for a shop with nothing linked). If the service did not answer, the button stays and a send
     * comes back with the service's own sentence. Shops without Inventory get Share: the only place to
     * link a number is Inventory's Settings -> WhatsApp.
     */
    whatsappReady: whatsappConfig() !== null && (account === null || account.status === 'CONNECTED'),
    // For Settings -> WhatsApp: what this till sends from. Sent by a person, one per press (12 Oct).
    whatsapp: { configured: whatsappConfig() !== null, account, sendsAs: await platformClientId(actor.clientId) },
    counters,
    cashier: { id: actor.id, name: actor.name ?? null },
    permissions: actor.permissions
  };
}

/**
 * The shop's UPI ID, for a QR with the amount already in it. POS-PAY-012. Owner-only.
 *
 * Checked for shape only (name@bank). Whether money actually reaches it cannot be known from here --
 * which is why a payment by QR still needs its reference, exactly like any other UPI payment.
 */
export async function setUpiId(actor: Actor, raw: string | null) {
  if (!may(actor, PERMISSIONS.SETTINGS)) throw forbidden('Only the owner can change where UPI payments go.');
  const upiId = raw === null ? null : String(raw).trim().toLowerCase();
  if (upiId !== null && !/^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/.test(upiId)) {
    throw badRequest('That is not a UPI ID. It looks like name@bank — for example lakshmisilks@okhdfcbank.');
  }
  await prisma.shopSettings.update({ where: { clientId: actor.clientId }, data: { upiId } });
  await record(actor, { action: 'shop.upi_set', detail: { upiId } });
  return forTill(actor);
}

/**
 * Which ways of paying the shop takes at the counter: cash, UPI, card (POS-SET-003). Owner-only.
 * There was no way to change them -- fixed at setup (found 9 Oct, writing the help). Points and store
 * credit are not here: they are the customer's own balance. At least one stays on, or nothing could be
 * sold. Turned off, a way is refused by every route, an older till included (planPayments).
 */
export const COUNTER_METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'] as const;
export async function setPaymentMethods(actor: Actor, raw: unknown) {
  if (!may(actor, PERMISSIONS.SETTINGS)) throw forbidden('Only the owner can change how the shop is paid.');
  const asked = Array.isArray(raw) ? raw.map(m => String(m).toUpperCase()) : [];
  const methods = COUNTER_METHODS.filter(m => asked.includes(m));
  if (asked.some(m => !(COUNTER_METHODS as readonly string[]).includes(m))) {
    throw badRequest('Only cash, UPI, card, bank transfer and cheque are switched on or off here.', { code: 'BAD_METHOD' });
  }
  if (methods.length === 0) throw badRequest('Keep at least one way to pay switched on.', { code: 'NO_METHOD' });
  await prisma.shopSettings.update({ where: { clientId: actor.clientId }, data: { enabledPaymentMethods: [...methods] } });
  await record(actor, { action: 'shop.payment_methods_set', detail: { methods } });
  return forTill(actor);
}

/**
 * The logo on the bill. POS-RCPT-011. Owner-only.
 *
 * Taken as a JPEG data URL, which the Settings screen makes from whatever picture the owner picks:
 * a small JPEG embeds in the hand-written receipt PDF with no image library on either side, and
 * nothing to host. An https address is accepted too, for a shop that already has one somewhere --
 * it shows on screen and on paper, and is left out of the PDF, which cannot fetch.
 *
 * ponytail: one picture, stored on the settings row. If logos ever need resizing server-side or
 * a PNG kept as PNG, that is an image library and a file store, not this function.
 */
const LOGO_MAX_CHARS = 200_000; // ~150 KB of JPEG, which is far more than a 42 mm print needs
export async function setLogo(actor: Actor, raw: string | null) {
  if (!may(actor, PERMISSIONS.SETTINGS)) throw forbidden('Only the owner can change the logo on the bill.');
  const link = await prisma.inventoryLink.findUnique({ where: { clientId: actor.clientId }, select: { connected: true } });
  if (link?.connected) throw conflict('This shop is connected to Inventory, so its logo is set there: Settings -> Name, logo and bill details. It reaches the till with the next item refresh.', { code: 'SET_IN_INVENTORY' });
  const logoUrl = raw === null ? null : String(raw).trim();
  if (logoUrl !== null) {
    const jpeg = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(logoUrl);
    const web = /^https:\/\/[^\s]{4,500}$/.test(logoUrl);
    if (!jpeg && !web) throw badRequest('That is not a picture the till can use. Choose an image file, or give an https address.');
    if (logoUrl.length > LOGO_MAX_CHARS) throw badRequest('That picture is too large for a bill. Choose a smaller one.');
  }
  await prisma.shopSettings.update({ where: { clientId: actor.clientId }, data: { logoUrl } });
  await record(actor, { action: 'shop.logo_set', detail: { kind: logoUrl === null ? 'removed' : logoUrl.startsWith('data:') ? 'picture' : 'address', chars: logoUrl?.length ?? 0 } });
  return forTill(actor);
}

/**
 * The shop's GST registration (REGULAR | COMPOSITION | UNREGISTERED). Owner-only.
 *
 * Only for a shop with no Inventory. A connected shop's registration is set in Inventory (Settings ->
 * Name, logo and bill details) and comes down with the items, so there is one answer in one place.
 * A change affects bills from now on; every bill already issued keeps the kind it was issued as.
 */
/**
 * THE SHOP'S OWN DETAILS, BY ITS OWNER (28 Oct). A shop without Inventory could not change its own name,
 * address, phone, GSTIN or bill footer -- "set up by ScaleEzy" -- nor the cashier's discount limit or the
 * return window. They are printed on every bill, so they are the owner's to keep right.
 *
 * A GSTIN must pass the checksum: it decides CGST+SGST or IGST on every bill from now on (its first two
 * digits are the shop's state). Bills already given out keep what they printed. The bill-number prefix is
 * NOT here: changing it mid-year starts a second series, which GST wants to be one unbroken run.
 *
 * Owner only; refused while connected (Inventory's Settings own these then, and send them to the till).
 */
export async function setShopDetails(actor: Actor, input: {
  shopName?: string; address?: string | null; phone?: string | null; gstin?: string | null; receiptFooter?: string | null;
  manualDiscountMaxPercent?: number; returnWindowDays?: number | null;
}) {
  if (!may(actor, PERMISSIONS.SETTINGS)) throw forbidden('Only the owner can change the shop\'s details.', { code: 'NOT_PERMITTED' });
  const link = await prisma.inventoryLink.findUnique({ where: { clientId: actor.clientId }, select: { connected: true } });
  if (link?.connected) throw conflict('This shop is connected to Inventory, so its details are set there: Settings -> Name, logo and bill details.', { code: 'FROM_INVENTORY' });
  const text = (v: unknown, most: number) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t ? t.slice(0, most) : null; };
  const data: Record<string, unknown> = {};
  if (input.shopName !== undefined) {
    const name = text(input.shopName, 80);
    if (!name || name.length < 2) throw badRequest('Type the shop\'s name as it should read on the bill.', { code: 'BAD_NAME', field: 'shopName' });
    data.shopName = name;
  }
  if (input.address !== undefined) data.address = text(input.address, 200);
  if (input.phone !== undefined) {
    const phone = text(input.phone, 30);
    // A shop's number may be a landline with an STD code: digits, spaces, + - ( ), 6 to 15 digits.
    if (phone && (!/^[+0-9 ()-]+$/.test(phone) || phone.replace(/\D/g, '').length < 6 || phone.replace(/\D/g, '').length > 15)) {
      throw badRequest('That does not look like a phone number.', { code: 'BAD_PHONE', field: 'phone' });
    }
    data.phone = phone;
  }
  if (input.gstin !== undefined) {
    const raw = String(input.gstin ?? '').trim();
    // Checked only when it changes: the form sends every field back, and a GSTIN already on file (set up
    // before this check existed) must not stop the owner fixing the address (found by check-shop-basics-ui).
    const current = (await prisma.shopSettings.findUnique({ where: { clientId: actor.clientId }, select: { gstin: true } }))?.gstin ?? null;
    if (raw && normaliseGstin(raw) === current) {
      data.gstin = current;
    } else if (raw) {
      const problem = gstinProblem(raw);
      if (problem) throw badRequest(problem.replace('their GST certificate', 'the shop\'s GST certificate'), { code: 'BAD_GSTIN', field: 'gstin' });
      data.gstin = normaliseGstin(raw);
    } else data.gstin = null;
  }
  if (input.receiptFooter !== undefined) data.receiptFooter = text(input.receiptFooter, 160);
  if (input.manualDiscountMaxPercent !== undefined) {
    const p = Number(input.manualDiscountMaxPercent);
    if (!Number.isInteger(p) || p < 0 || p > 100) throw badRequest('A discount limit is a whole percent, 0 to 100.', { code: 'BAD_DISCOUNT', field: 'manualDiscountMaxPercent' });
    data.manualDiscountMaxPercent = p;
  }
  if (input.returnWindowDays !== undefined) {
    const d = input.returnWindowDays;
    if (d !== null && (!Number.isInteger(d) || d < 0 || d > 365)) throw badRequest('Returns are taken for 0 to 365 days, or leave it empty for any time.', { code: 'BAD_RETURN_WINDOW', field: 'returnWindowDays' });
    data.returnWindowDays = d;
  }
  if (!Object.keys(data).length) return forTill(actor);
  const before = await prisma.shopSettings.findUnique({ where: { clientId: actor.clientId }, select: { shopName: true, address: true, phone: true, gstin: true, receiptFooter: true, manualDiscountMaxPercent: true, returnWindowDays: true } });
  const changed = Object.keys(data).filter(k => (before as any)?.[k] !== data[k]);
  if (changed.length) {
    await prisma.shopSettings.update({ where: { clientId: actor.clientId }, data });
    await record(actor, { action: 'shop.details_set', detail: Object.fromEntries(changed.map(k => [k, { from: (before as any)?.[k] ?? null, to: data[k] ?? null }])) as any });
  }
  return forTill(actor);
}

export async function setGstRegistration(actor: Actor, raw: string) {
  if (!may(actor, PERMISSIONS.SETTINGS)) throw forbidden('Only the owner can change how the shop is registered for GST.');
  const registration = String(raw ?? '').toUpperCase();
  if (!(REGISTRATIONS as readonly string[]).includes(registration)) throw badRequest('Choose GST registered, composition, or not registered.');
  const link = await prisma.inventoryLink.findUnique({ where: { clientId: actor.clientId }, select: { connected: true } });
  if (link?.connected) throw conflict('This shop is connected to Inventory, so its GST registration is set there: Settings -> Name, logo and bill details. It reaches the till with the next item refresh.');
  await prisma.shopSettings.update({ where: { clientId: actor.clientId }, data: { gstRegistration: registration } });
  await record(actor, { action: 'shop.gst_registration_set', detail: { registration } });
  return forTill(actor);
}
