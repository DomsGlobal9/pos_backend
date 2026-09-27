import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { notFound } from '../../utils/httpError';

/**
 * What the till needs to know before it can sell: which shop it is, and which counters it has.
 *
 * Asked once when the till loads rather than per sale. It carries no prices and no stock, so it is
 * safe to cache hard in the browser -- which matters, because it is on the path between opening
 * the till and being able to scan.
 */
export async function forTill(actor: Actor) {
  const [settings, counters] = await Promise.all([
    prisma.shopSettings.findUnique({
      where: { clientId: actor.clientId },
      select: {
        shopName: true, gstin: true, address: true, logoUrl: true, receiptFooter: true,
        enabledPaymentMethods: true, manualDiscountMaxPercent: true, returnWindowDays: true,
        holdThresholdQty: true
      }
    }),
    prisma.counter.findMany({
      where: { clientId: actor.clientId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true }
    })
  ]);

  if (!settings) throw notFound('This shop is not set up yet.');

  return {
    shop: settings,
    counters,
    cashier: { id: actor.id, name: actor.name ?? null },
    permissions: actor.permissions
  };
}
