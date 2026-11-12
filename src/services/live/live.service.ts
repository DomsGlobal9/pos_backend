/**
 * LIVE -- every open screen of a shop hears at once that something changed (12 Nov, owner:
 * "everything in a blink of an eye, without refresh, across all modules").
 *
 * The screens used to look again on timers (15 s to 3 min). Now the server says "this changed" the
 * moment it happens -- a bill saved at another till, a sale accepted by Inventory, items refreshed,
 * a customer sent to CRM -- and each screen refetches what it shows. The timers stay as the fallback
 * for a screen whose line dropped.
 *
 * And what the till sends goes at once: a bill is handed to Inventory and CRM as soon as it is saved,
 * not on the next pass. Inventory's queue already holds a per-shop lease, so a send started here and
 * the 15-second pass never send the same event twice.
 *
 * In memory, one server: pos-backend runs as one instance. A second instance would need a shared
 * channel (Postgres LISTEN/NOTIFY) -- the screens would still be right, only up to a timer late.
 */
import { prisma } from '../../lib/prisma';
import { drain } from '../inventory-link/delivery.service';
import { sendCrm } from '../crm/crm.service';

export type Topic = 'sales' | 'inventory-link' | 'items' | 'customers';
type Listener = (topics: Topic[]) => void;

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<string, { topics: Set<Topic>; timer: NodeJS.Timeout }>();

/** A screen of this shop listening. Returns how to stop. */
export function listen(clientId: string, fn: Listener) {
  if (!listeners.has(clientId)) listeners.set(clientId, new Set());
  listeners.get(clientId)!.add(fn);
  return () => {
    const set = listeners.get(clientId);
    set?.delete(fn);
    if (set && set.size === 0) listeners.delete(clientId);
  };
}

/** Tell this shop's screens. A burst (a bill, its CRM row, its send) goes as one message. */
export function notify(clientId: string, ...topics: Topic[]) {
  if (!listeners.has(clientId)) return;
  const p = pending.get(clientId);
  if (p) { topics.forEach(t => p.topics.add(t)); return; }
  const timer = setTimeout(() => {
    const entry = pending.get(clientId);
    pending.delete(clientId);
    const all = [...(entry?.topics ?? [])];
    for (const fn of listeners.get(clientId) ?? []) {
      try { fn(all); } catch { /* one closed screen never stops the others */ }
    }
  }, 150);
  pending.set(clientId, { topics: new Set(topics), timer });
}

const sending = new Set<string>();
const sendAgain = new Set<string>();

/** Send this shop's waiting news now: to Inventory, then to CRM. Never two at once for one shop. */
export function sendNow(clientId: string) {
  if (sending.has(clientId)) { sendAgain.add(clientId); return; }
  sending.add(clientId);
  void (async () => {
    try {
      const link = await prisma.inventoryLink.findUnique({ where: { clientId }, select: { connected: true, blockedSequence: true } });
      if (link?.connected && link.blockedSequence === null) {
        const r = await drain(clientId, 20);
        if (r.sent) notify(clientId, 'inventory-link');
      }
      for (let i = 0; i < 3; i++) {
        const c = await sendCrm(clientId);
        if (c.sent || c.setAside) notify(clientId, 'inventory-link');
        if (c.outcome !== 'SENT' && c.outcome !== 'SET_ASIDE') break;
      }
    } catch (error) {
      // The timed passes pick it up; a failed instant send loses nothing.
      console.error(`[live] sending now for ${clientId} failed:`, (error as Error).message);
    } finally {
      sending.delete(clientId);
      if (sendAgain.delete(clientId)) sendNow(clientId);
    }
  })();
}
