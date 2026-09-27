import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { forbidden, notFound } from '../../utils/httpError';
import { open } from '../../utils/credential';
import { EVENT_VERSION } from '../events';
import { sign } from './sign';
import { checkAddress } from './endpoints.service';

/**
 * Sending webhooks. POS-WEB-002..006.
 *
 * CLAIMED WITH A LEASE, NOT HELD (POS-WEB-004). A row is taken by one guarded UPDATE that sets it
 * DELIVERING with `lockedAt`. A worker that dies mid-send leaves a DELIVERING row whose lease runs
 * out after two minutes, and the next pass takes it again. That column is the difference between
 * this sender and Inventory's first outbox, which stranded 747 events.
 *
 * AT LEAST ONCE. A receiver may see a notice twice (it answered, the answer was lost). Each carries
 * its `sequence`: a receiver keeps the highest it has applied and ignores anything at or below it
 * for the same bill -- which also puts notices that arrive out of order right (POS-WEB-002).
 *
 * FAIR. At most 10 per shop per pass, so one shop's backlog of 400 cannot starve everyone else.
 */

const LEASE_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;
export const MAX_ATTEMPTS = 8;
// After the 1st..7th failure. About 22 hours in all -- a weekend outage at a small accountant's
// office should not lose a Saturday's sales, and nothing is dropped even then (FAILED is resendable).
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];

/** Take up to `limit` notices that are due, fairly across shops. */
export async function claim(limit = 100, perShop = 10): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE webhook_deliveries d
       SET status = 'DELIVERING', locked_at = now() AT TIME ZONE 'UTC'
     WHERE d.id IN (
             SELECT id FROM (
               SELECT id, row_number() OVER (PARTITION BY client_id ORDER BY created_at) AS rn
                 FROM webhook_deliveries
                WHERE (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= now() AT TIME ZONE 'UTC'))
                   OR (status = 'DELIVERING' AND locked_at < (now() AT TIME ZONE 'UTC') - (${LEASE_MS} || ' milliseconds')::interval)
             ) due
             WHERE rn <= ${perShop}
             LIMIT ${limit})
       -- Checked again under the row lock: a second sender that read the same row loses here.
       AND ((d.status = 'PENDING' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now() AT TIME ZONE 'UTC'))
         OR (d.status = 'DELIVERING' AND d.locked_at < (now() AT TIME ZONE 'UTC') - (${LEASE_MS} || ' milliseconds')::interval))
 RETURNING d.id`;
  return rows.map(r => r.id);
}

/** The body a receiver gets. Public identities only; our ids never leave. */
export function envelope(e: { sequence: bigint; eventType: string; eventVersion: number; createdAt: Date; payload: unknown }) {
  return JSON.stringify({
    type: e.eventType,
    version: e.eventVersion,
    sequence: e.sequence.toString(),
    occurredAt: e.createdAt.toISOString(),
    data: e.payload
  });
}

/** Send one claimed notice and record what happened. */
export async function deliverOne(deliveryId: string): Promise<'DELIVERED' | 'RETRY' | 'FAILED' | 'GONE'> {
  const d = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      event: { select: { sequence: true, eventType: true, eventVersion: true, createdAt: true, payload: true } },
      endpoint: { select: { id: true, url: true, secretCipher: true, active: true } }
    }
  });
  if (!d) return 'GONE';
  if (!d.endpoint.active) {
    // Switched off after this was queued: leave it waiting, untouched, for when it is switched on.
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'PENDING', lockedAt: null, nextAttemptAt: new Date(Date.now() + 60 * 60_000) } });
    return 'RETRY';
  }

  const body = envelope(d.event);
  const ts = Math.floor(Date.now() / 1000);
  let code: number | null = null;
  let note: string | null = null;
  try {
    await checkAddress(d.endpoint.url); // DNS may have moved since it was saved
    const res = await fetch(d.endpoint.url, {
      method: 'POST',
      redirect: 'manual', // a redirect could point anywhere, including inside our network
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'ScaleEzy-POS-Webhooks/1',
        'x-scaleezy-event': d.event.eventType,
        'x-scaleezy-event-version': String(d.event.eventVersion ?? EVENT_VERSION),
        'x-scaleezy-sequence': d.event.sequence.toString(),
        'x-scaleezy-timestamp': String(ts),
        'x-scaleezy-signature': sign(open(d.endpoint.secretCipher), ts, body)
      },
      body
    });
    code = res.status;
    note = (await res.text().catch(() => '')).slice(0, 500) || null;
  } catch (error: any) {
    note = error?.name === 'TimeoutError' ? 'no answer within 10 seconds' : (error?.message ?? 'could not connect').slice(0, 200);
  }

  const now = new Date();
  if (code !== null && code >= 200 && code < 300) {
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: d.id },
        data: { status: 'DELIVERED', attempts: d.attempts + 1, lastAttemptAt: now, deliveredAt: now, responseCode: code, responseBody: note, lockedAt: null, nextAttemptAt: null }
      }),
      prisma.webhookEndpoint.update({ where: { id: d.endpoint.id }, data: { lastDeliveryAt: now, failingSince: null } })
    ]);
    return 'DELIVERED';
  }

  const attempts = d.attempts + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  await prisma.webhookDelivery.update({
    where: { id: d.id },
    data: {
      status: giveUp ? 'FAILED' : 'PENDING', attempts, lastAttemptAt: now, responseCode: code, responseBody: note, lockedAt: null,
      nextAttemptAt: giveUp ? null : new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1])
    }
  });
  if (giveUp) {
    await prisma.webhookEndpoint.updateMany({ where: { id: d.endpoint.id, failingSince: null }, data: { failingSince: now } });
  }
  return giveUp ? 'FAILED' : 'RETRY';
}

/** One pass: claim what is due and send it, a few at a time. */
export async function runOnce() {
  const ids = await claim();
  const results: Record<string, number> = {};
  for (let i = 0; i < ids.length; i += 5) {
    const batch = await Promise.all(ids.slice(i, i + 5).map(id => deliverOne(id).catch(error => {
      console.error('[webhooks] delivery failed unexpectedly:', (error as Error).message);
      return 'RETRY' as const;
    })));
    for (const r of batch) results[r] = (results[r] ?? 0) + 1;
  }
  return { claimed: ids.length, ...results };
}

/**
 * The Test button: a `ping` to one address, sent now, answered now. Written as a real event and
 * delivery so it shows in the history like any other -- but only to this address.
 */
export async function ping(actor: Actor, endpointId: string) {
  if (!may(actor, PERMISSIONS.INTEGRATIONS)) throw forbidden('Only the owner can manage connections to other software.');
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, clientId: actor.clientId } });
  if (!endpoint) throw notFound('That connection was not found.');
  const event = await prisma.webhookEvent.create({
    data: { clientId: actor.clientId, eventType: 'ping', eventVersion: EVENT_VERSION, invoiceNo: null, payload: { message: 'A test from ScaleEzy POS.', connection: endpoint.name } }
  });
  const delivery = await prisma.webhookDelivery.create({
    data: { eventId: event.id, endpointId, clientId: actor.clientId, status: 'DELIVERING', lockedAt: new Date() }
  });
  const outcome = await deliverOne(delivery.id);
  // A test that failed is not retried: the owner pressed a button and is watching for the answer.
  if (outcome !== 'DELIVERED') {
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', nextAttemptAt: null } });
  }
  const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
  return {
    received: outcome === 'DELIVERED',
    message: outcome === 'DELIVERED'
      ? 'Your software received the test.'
      : after.responseCode !== null
        ? `Your software answered with an error (${after.responseCode}). Nothing else is affected.`
        : `Could not reach your software (${after.responseBody ?? 'no answer'}). Nothing else is affected.`
  };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Started by the server unless DISABLE_BACKGROUND_JOBS. A pass never overlaps the one before. */
export function startWebhookLoop(everyMs = 10_000) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runOnce(); }
    catch (error) { console.error('[webhooks] pass failed:', (error as Error).message); }
    finally { running = false; }
  }, everyMs);
  timer.unref();
}
