import { REGISTRATIONS } from './gst-document';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { may, PERMISSIONS } from '../../types/actor';
import { record } from '../audit';
import { whatsappConfig } from '../receipt-send';

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
        shopName: true, gstin: true, address: true, logoUrl: true, receiptFooter: true, upiQrEnabled: true,
        enabledPaymentMethods: true, manualDiscountMaxPercent: true, returnWindowDays: true,
        holdThresholdQty: true, upiId: true, gstRegistration: true
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
     * WhatsApp instead. Only the settings, not whether the shop's number is linked -- that is a
     * question for the WhatsApp service and not worth a network call on every screen load; a send
     * to an unlinked number comes back with the service's own sentence.
     *
     * It is false for every shop that does not use Inventory, because the only place to link a
     * number today is Inventory's own settings. Those shops get Share, which needs nothing.
     */
    whatsappReady: whatsappConfig() !== null,
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
