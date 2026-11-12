import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { refreshShop } from './catalogue.service';
import { eraseHere } from './erasures.service';
import { notify } from '../live/live.service';

/**
 * INVENTORY TELLS THE TILL AT ONCE (12 Nov, PLAN-live step 3; Inventory 9c16a4e).
 *
 * Until now the till found out by asking: items every 30 s, erasures every 5 min. Inventory now pushes
 * two things the moment they happen, signed with POS_EVENTS_SECRET over "timestamp.rawBody":
 *
 *   catalogue.changed  something the till shows changed (products, stock, offers, settings) -- no data
 *                      comes with it; the till does its usual pull from its last cursor, then its
 *                      screens hear "items" on /live
 *   customer.erased    { phone, erasedAt }, the same as a row of GET /erasures
 *
 * Each event is stored first (Inventory's id makes a retry a no-op), the answer goes back at once,
 * and the work follows. The pulls stay as the safety net for a push that never arrives.
 */
const TOLERANCE_SECONDS = 300;

export type Verdict = 'ok' | 'stale' | 'bad' | 'off';

export function verifyPush(timestamp: unknown, signature: unknown, rawBody: Buffer | undefined, now = Date.now()): Verdict {
  const secret = env.POS_EVENTS_SECRET;
  if (!secret) return 'off';
  const ts = String(timestamp ?? '').trim();
  const given = String(signature ?? '').trim().toLowerCase();
  if (!rawBody || !/^\d{9,11}$/.test(ts) || !/^sha256=[0-9a-f]{64}$/.test(given)) return 'bad';
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex')}`);
  const presented = Buffer.from(given);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return 'bad';
  // After the signature, so a stranger learns nothing about our clock.
  return Math.abs(Math.floor(now / 1000) - Number(ts)) > TOLERANCE_SECONDS ? 'stale' : 'ok';
}

export const pushBody = z.object({
  clientId: z.string().min(1).max(80),
  events: z.array(z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    kind: z.string().min(1).max(80),
    occurredAt: z.string().optional(),
    payload: z.any().optional()
  })).max(500)
});

/** Keep what came, once. Returns how many were new. */
export async function storePush(body: z.infer<typeof pushBody>) {
  const r = await prisma.inventoryInbound.createMany({
    data: body.events.map(e => ({ inventoryShop: body.clientId, eventId: e.id, kind: e.kind, payload: (e.payload ?? {}) as object })),
    skipDuplicates: true
  });
  return r.count;
}

let current: Promise<void> | null = null;
let again = false;

/**
 * Work what is stored and not yet done, oldest first. One run at a time: a call while one is running
 * asks it to go round once more and waits for it, so whoever called knows the work is done.
 */
export function workPushes(): Promise<void> {
  if (current) { again = true; return current; }
  current = (async () => {
    try {
      do {
        again = false;
        const rows = await prisma.inventoryInbound.findMany({ where: { processedAt: null }, orderBy: { receivedAt: 'asc' }, take: 200 });
        // A burst of "the catalogue changed" for one shop is one refresh.
        const refreshed = new Set<string>();
        for (const row of rows) {
          const outcome = await workOne(row, refreshed).catch((error: Error) => `FAILED: ${error.message}`.slice(0, 200));
          await prisma.inventoryInbound.update({ where: { id: row.id }, data: { processedAt: new Date(), outcome } });
        }
      } while (again);
    } finally { current = null; }
  })();
  return current;
}

async function workOne(row: { inventoryShop: string; eventId: string; kind: string; payload: any }, refreshed: Set<string>) {
  // The till shops that send to this Inventory shop. One that has a key for another shop gets nothing.
  const links = await prisma.inventoryLink.findMany({ where: { platformClientId: row.inventoryShop, connected: true }, select: { clientId: true, blockedCode: true } });
  const mine = links.filter(l => l.blockedCode !== 'SHOP_CHANGED');
  if (!mine.length) return 'NO_SUCH_SHOP';
  if (row.kind === 'catalogue.changed') {
    for (const l of mine) {
      if (refreshed.has(l.clientId)) continue;
      refreshed.add(l.clientId);
      await refreshShop(l.clientId);
    }
    return 'REFRESHED';
  }
  if (row.kind === 'customer.erased') {
    const outcomes = [];
    for (const l of mine) {
      const how = await eraseHere(l.clientId, { id: row.eventId, phone: row.payload?.phone, erasedAt: row.payload?.erasedAt });
      // Counted here: the list read later finds them already gone and counts nothing.
      if (how === 'ERASED' || how === 'DETACHED') {
        await prisma.inventoryLink.update({ where: { clientId: l.clientId }, data: { erasedCount: { increment: 1 } } });
        notify(l.clientId, 'customers', 'sales', 'inventory-link');
      }
      outcomes.push(how);
    }
    return outcomes.join(',');
  }
  return 'IGNORED';
}

/** Anything stored but not worked (the server stopped between the answer and the work): every minute. */
export function startInboundSweep(everyMs = 60_000) {
  const t = setInterval(() => { workPushes().catch(error => console.error('[inventory-inbound] sweep failed:', (error as Error).message)); }, everyMs);
  t.unref();
}
