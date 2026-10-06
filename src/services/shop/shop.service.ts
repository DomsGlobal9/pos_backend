import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { badRequest, forbidden, notFound } from '../../utils/httpError';
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
        shopName: true, gstin: true, address: true, logoUrl: true, receiptFooter: true,
        enabledPaymentMethods: true, manualDiscountMaxPercent: true, returnWindowDays: true,
        holdThresholdQty: true, upiId: true
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
    throw badRequest('That is not a UPI ID. It looks like name@bank -- for example lakshmisilks@okhdfcbank.');
  }
  await prisma.shopSettings.update({ where: { clientId: actor.clientId }, data: { upiId } });
  await record(actor, { action: 'shop.upi_set', detail: { upiId } });
  return forTill(actor);
}
