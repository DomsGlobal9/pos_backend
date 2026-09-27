import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, conflict, forbidden } from '../../utils/httpError';
import { seal } from '../../utils/credential';
import { record } from '../audit';
import { call } from './client';
import { STOCK_EVENTS } from './delivery.service';

/**
 * Connecting a shop's till to Inventory, and the owner's view of how that link is doing.
 * POS-INV-009, POS-SYNC-006.
 *
 * Owner-only (`settings:manage`). A cashier never manages the integration (MASTER §2 rule 9); what
 * a cashier sees is one plain sentence on the till when stock cannot be checked, nothing more.
 *
 * CONNECTING DOES NOT REPLAY THE PAST. A shop that sold standalone for a month did not sell
 * Inventory's stock -- its items were its own. So the first connect starts delivery from the
 * events written AFTER it. A shop that disconnects and reconnects carries on from where it
 * stopped, because those sales were made against Inventory's items and their stock must move.
 */

const WHEN_DOWN = ['SELL', 'CHECK_SHELF'] as const;

function mustManage(actor: Actor) {
  if (!may(actor, PERMISSIONS.SETTINGS)) {
    throw forbidden('Only the owner can change how the till connects to Inventory.', { code: 'NOT_PERMITTED' });
  }
}

/** Ask Inventory whether this key works, in words the owner can act on. */
async function tryKey(baseUrl: string, keyCipher: string) {
  const reply = await call({ baseUrl, keyCipher }, 'GET', '/catalogue?limit=1', undefined, 8_000);
  if (reply.kind === 'UNREACHABLE') {
    throw conflict(`Inventory could not be reached at ${baseUrl} (${reply.reason}). Check the address, then try again.`, { code: 'UNREACHABLE' });
  }
  if (reply.status === 401 || reply.status === 403) {
    throw badRequest('Inventory did not accept that key. Copy it again from Inventory\'s connection page.', { code: 'KEY_REFUSED' });
  }
  if (reply.status === 404) {
    throw conflict('That Inventory does not have the POS link yet. It needs the update that adds it.', { code: 'NO_POS_LINK' });
  }
  if (reply.status >= 400) {
    throw conflict(`Inventory answered with an error (${reply.status}). Try again in a few minutes.`, { code: 'INVENTORY_ERROR' });
  }
}

export async function connect(actor: Actor, input: { key: string; baseUrl?: string; whenDown?: string }) {
  mustManage(actor);
  const key = (input.key ?? '').trim();
  if (key.length < 16) throw badRequest('Paste the whole connection key from Inventory.');
  // Inventory serves the POS link under /api/v1/pos/v1 (contract §1). The deployment setting is
  // Inventory's root; a test may give the full address directly.
  const baseUrl = (input.baseUrl ?? (env.INVENTORY_BASE_URL ? `${env.INVENTORY_BASE_URL.replace(/\/+$/, '')}/api/v1/pos/v1` : '')).trim();
  if (!/^https?:\/\/\S+$/.test(baseUrl)) {
    throw badRequest('This till has no Inventory address. Ask ScaleEzy support to set one.', { code: 'NO_ADDRESS' });
  }
  const whenDown = input.whenDown ?? 'SELL';
  if (!WHEN_DOWN.includes(whenDown as any)) throw badRequest('Choose what to do when Inventory cannot be reached.');

  const keyCipher = seal(key);
  await tryKey(baseUrl, keyCipher);

  const existing = await prisma.inventoryLink.findUnique({ where: { clientId: actor.clientId }, select: { clientId: true } });
  const latest = await prisma.webhookEvent.aggregate({ where: { clientId: actor.clientId }, _max: { sequence: true } });

  await prisma.inventoryLink.upsert({
    where: { clientId: actor.clientId },
    create: {
      clientId: actor.clientId, connected: true, baseUrl, keyCipher, keyPrefix: key.slice(0, 8), whenDown,
      // First connect: start after everything already written. See the header.
      deliveredSequence: latest._max.sequence ?? BigInt(0),
      connectedAt: new Date()
    },
    update: {
      connected: true, baseUrl, keyCipher, keyPrefix: key.slice(0, 8), whenDown,
      // A new key may be the fix for a key that stopped working -- clear that block.
      blockedSequence: null, blockedCode: null, blockedMessage: null,
      attempts: 0, nextAttemptAt: null, lastError: null, connectedAt: new Date()
    }
  });

  await record(actor, { action: 'inventory.connected', detail: { baseUrl, keyPrefix: key.slice(0, 8), firstTime: !existing } });
  return status(actor);
}

export async function disconnect(actor: Actor) {
  mustManage(actor);
  await prisma.inventoryLink.updateMany({ where: { clientId: actor.clientId }, data: { connected: false } });
  await record(actor, { action: 'inventory.disconnected' });
  return status(actor);
}

export async function setWhenDown(actor: Actor, whenDown: string) {
  mustManage(actor);
  if (!WHEN_DOWN.includes(whenDown as any)) throw badRequest('Choose what to do when Inventory cannot be reached.');
  await prisma.inventoryLink.updateMany({ where: { clientId: actor.clientId }, data: { whenDown } });
  return status(actor);
}

/** A person has fixed what stopped the queue. Clear it; the next delivery run tries again at once. */
export async function retry(actor: Actor) {
  mustManage(actor);
  await prisma.inventoryLink.updateMany({
    where: { clientId: actor.clientId },
    data: { blockedSequence: null, blockedCode: null, blockedMessage: null, attempts: 0, nextAttemptAt: null, lockedUntil: null }
  });
  await record(actor, { action: 'inventory.retried' });
  return status(actor);
}

/** The owner's view. Never includes the key. */
export async function status(actor: Actor) {
  const link = await prisma.inventoryLink.findUnique({ where: { clientId: actor.clientId } });
  const deploymentHasInventory = Boolean(env.INVENTORY_BASE_URL);
  if (!link) {
    return { mode: 'STANDALONE' as const, deploymentHasInventory, mayManage: may(actor, PERMISSIONS.SETTINGS) };
  }

  const waiting = await prisma.webhookEvent.count({
    where: { clientId: actor.clientId, eventType: { in: STOCK_EVENTS }, sequence: { gt: link.deliveredSequence } }
  });
  // Taken in by Inventory, not applied yet. Usually a few seconds; longer when Inventory is busy.
  const settling = await prisma.inventorySettlement.count({ where: { clientId: actor.clientId, settledAt: null } });
  const blockedEvent = link.blockedSequence
    ? await prisma.webhookEvent.findFirst({
        where: { clientId: actor.clientId, sequence: link.blockedSequence },
        select: { invoiceNo: true, eventType: true, createdAt: true }
      })
    : null;

  return {
    mode: link.connected ? ('CONNECTED' as const) : ('DISCONNECTED' as const),
    deploymentHasInventory,
    mayManage: may(actor, PERMISSIONS.SETTINGS),
    baseUrl: link.baseUrl,
    keyPrefix: link.keyPrefix,
    whenDown: link.whenDown,
    waiting,
    settling,
    lastDeliveredAt: link.lastDeliveredAt,
    nextAttemptAt: link.nextAttemptAt,
    lastError: link.lastError,
    blocked: link.blockedSequence
      ? { code: link.blockedCode, message: link.blockedMessage, document: blockedEvent?.invoiceNo ?? null, at: blockedEvent?.createdAt ?? null }
      : null,
    catalogueSyncedAt: link.catalogueSyncedAt,
    catalogueProblems: (link.catalogueProblems as string[] | null) ?? [],
    /** Notes on bills Inventory accepted. Newest first. */
    warnings: (link.recentWarnings as { at: string; document: string | null; text: string }[] | null) ?? []
  };
}
