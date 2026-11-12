import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { systemActor } from '../../types/actor';
import { record } from '../audit';
import { call } from './client';
import { notify } from '../live/live.service';

/**
 * A PERSON ERASED IN INVENTORY IS ERASED HERE TOO (12 Nov, owner; Inventory 11f5f58).
 *
 * Inventory lists what it erased -- the owner's erase and remove, and Shopify's privacy erasures --
 * at GET /erasures?since=, each with the number the person had at that moment and when. The till
 * reads it every five minutes and forgets what it knew of that number UP TO THAT MOMENT. A record or
 * bill of the same number afterwards is somebody new and stays (Inventory's rule: a number can be
 * erased, given to someone else, and erased again).
 *
 * What goes: the name, number, GSTIN, address, note, consent, credit limit and the cached balances on
 * the customer, which is marked removed (its number freed for whoever has it next); CRM rows not yet
 * sent; the customer block on the till's own copies of its events. What stays: the bills -- GST law
 * keeps invoices six years. A B2B tax invoice and a Rs 50,000+ consumer bill keep the buyer exactly as
 * issued; the till prints what the law requires, nothing more.
 */
export type Erasure = { id: string | number; phone: string; erasedAt: string };

/** Forget one erased number. Returns what happened, for the log and the tests. */
export async function eraseHere(clientId: string, e: Erasure): Promise<'ERASED' | 'DETACHED' | 'NEW_PERSON' | 'UNKNOWN'> {
  const at = new Date(e.erasedAt);
  if (!e.phone || Number.isNaN(at.getTime())) return 'UNKNOWN';
  const c = await prisma.customer.findFirst({ where: { clientId, phone: e.phone, deletedAt: null }, select: { id: true, createdAt: true } });
  type Outcome = 'ERASED' | 'DETACHED' | 'NEW_PERSON' | 'UNKNOWN';
  // Set inside the transaction below; the cast keeps TypeScript from fixing it at 'UNKNOWN'.
  let outcome = 'UNKNOWN' as Outcome;

  await prisma.$transaction(async (tx) => {
    if (c && c.createdAt <= at) {
      const since = await tx.sale.findFirst({ where: { clientId, customerId: c.id, createdAt: { gt: at } }, select: { id: true } });
      if (since) {
        // The record has served someone new since: keep it for them, and take the old bills off it.
        await tx.sale.updateMany({ where: { clientId, customerId: c.id, createdAt: { lte: at } }, data: { customerId: null } });
        await tx.return.updateMany({ where: { clientId, customerId: c.id, createdAt: { lte: at } }, data: { customerId: null } });
        outcome = 'DETACHED';
      } else {
        await tx.customer.update({
          where: { id: c.id },
          data: {
            phone: `erased:${c.id}`, name: null, gstin: null, address: null, note: null,
            marketingConsent: false, consentAt: null, creditLimitPaise: null, storeCreditPaise: 0, loyaltyPoints: 0,
            deletedAt: new Date()
          }
        });
        outcome = 'ERASED';
      }
      await tx.crmOutbox.deleteMany({ where: { clientId, sentAt: null, payload: { path: ['customerId'], equals: c.id } } });
    } else if (c) {
      outcome = 'NEW_PERSON';
    }
    // The till's own copies of its events: the person's number and name come off those up to then.
    await tx.$executeRaw`
      UPDATE webhook_events
         SET payload = jsonb_set(jsonb_set(payload, '{customerRef}', 'null'::jsonb), '{customer}', 'null'::jsonb)
       WHERE client_id = ${clientId}
         AND created_at <= ${at}
         AND (payload->>'customerRef' = ${e.phone} OR payload->'customer'->>'phone' = ${e.phone})`;
  });

  if (outcome === 'ERASED' || outcome === 'DETACHED') {
    await record(systemActor(clientId), { action: 'customer.erased', subject: c!.id, detail: { by: 'Inventory', erasedAt: e.erasedAt, how: outcome } as Prisma.InputJsonValue });
  }
  return outcome;
}

/** Read Inventory's list from where this till left off, and forget each one. */
export async function readErasures(clientId: string) {
  const link = await prisma.inventoryLink.findUnique({ where: { clientId } });
  if (!link?.connected || link.blockedCode === 'SHOP_CHANGED') return { done: 0 };
  let since = link.erasureCursor ?? '0';
  let done = 0;
  for (let page = 0; page < 20; page++) {
    const reply = await call(link, 'GET', `/erasures?since=${encodeURIComponent(since)}`, undefined, 15_000);
    // An Inventory without the list yet, or a hiccup: next pass.
    if (reply.kind === 'UNREACHABLE' || reply.status !== 200) return { done };
    const data = reply.body?.data ?? reply.body ?? {};
    let onPage = 0;
    for (const e of Array.isArray(data.erasures) ? data.erasures : []) {
      const how = await eraseHere(clientId, e);
      if (how === 'ERASED' || how === 'DETACHED') onPage++;
    }
    done += onPage;
    if (typeof data.next === 'string' && /^\d+$/.test(data.next)) since = data.next;
    // The time is shown to the owner: proof the list is being read, even when it is empty.
    await prisma.inventoryLink.update({ where: { clientId }, data: { erasureCursor: since, erasuresCheckedAt: new Date(), erasedCount: { increment: onPage } } });
    if (!data.more) break;
  }
  if (done) notify(clientId, 'customers', 'sales');
  return { done };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function pass() {
  if (running) return;
  running = true;
  try {
    const links = await prisma.inventoryLink.findMany({ where: { connected: true }, select: { clientId: true } });
    for (const l of links) {
      try { await readErasures(l.clientId); }
      catch (error) { console.error(`[inventory-link] erasures for ${l.clientId} failed:`, (error as Error).message); }
    }
  } catch (error) { console.error('[inventory-link] erasure pass failed:', (error as Error).message); }
  finally { running = false; }
}

/**
 * Every five minutes (Inventory keeps the list 30 days), and once half a minute after the server
 * starts -- a deploy should not leave the owner's "checked" waiting five minutes.
 */
export function startErasureLoop(everyMs = 5 * 60_000) {
  if (timer) return;
  timer = setInterval(pass, everyMs);
  timer.unref();
  setTimeout(pass, 30_000).unref();
}
