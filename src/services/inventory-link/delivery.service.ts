import { prisma } from '../../lib/prisma';
import { call } from './client';

/**
 * Sending the outbox to Inventory. POS-INV-006, -007, -008. Contract §4.
 *
 * ONE EVENT AT A TIME, IN ORDER, PER SHOP. A return must never reach Inventory before the sale it
 * is against, so there is no parallelism within a shop and no skipping.
 *
 * Three kinds of answer, three behaviours:
 *
 *   accepted (APPLIED / ALREADY_APPLIED)   move the cursor on
 *   refused, a person must look            STOP this shop's queue and say why, in words.
 *                                          (Sending what comes after a refused sale would be wrong.)
 *   not answered / busy / broken           try the same event again later, backing off
 *
 * Nothing here is on the path of a sale. A sale writes its event and is done; this runs on a timer
 * and when an owner presses Retry.
 *
 * TIMES IN SQL ARE UTC, SAID OUT LOUD. Prisma stores `DateTime` as UTC in a column without a zone;
 * Postgres `now()` is the SESSION's local time. The local database runs on India time, so a bare
 * `now()` here was 5.5 hours ahead of every stored time and let a busy Inventory be retried at once
 * instead of in 30 seconds. Found by verify-inventory-link; every raw `now()` in the POS now reads
 * `now() AT TIME ZONE 'UTC'`.
 *
 * A LEASE, NOT A LOCK HELD OVER HTTP. `lockedUntil` is taken with one guarded UPDATE, so two server
 * instances never send the same event at once -- and a process that dies mid-send frees the shop
 * again after 30 seconds instead of holding it forever.
 */

export const STOCK_EVENTS = ['sale.completed', 'sale.returned', 'sale.exchanged'];

const LEASE_MS = 30_000;
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
export const backoffFor = (attempts: number) => BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? 60 * 60_000;

/** Why the queue stopped, as the owner will read it. Never a status code on its own. */
function refusal(status: number, body: any): { code: string; message: string } | null {
  const code = body?.details?.code as string | undefined;
  if (status === 401 || status === 403) {
    return { code: 'KEY_REFUSED', message: 'Inventory no longer accepts this till\'s key. Connect again with a new key from Inventory.' };
  }
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    const said = typeof body?.message === 'string' ? ` Inventory said: "${body.message}"` : '';
    const known: Record<string, string> = {
      UNKNOWN_ITEM: `An item on this bill (${body?.details?.itemCode ?? 'unknown code'}) is not in Inventory.`,
      UNKNOWN_ORDER: `Inventory has no record of the original bill ${body?.details?.invoiceNo ?? ''}.`,
      QTY_EXCEEDS_SOLD: 'Inventory thinks more is being returned than was sold.',
      AMOUNT_MISMATCH: `Inventory worked out a different refund for ${body?.details?.itemCode ?? 'a line'}.`,
      BAD_PAYLOAD: 'Inventory could not read this bill.'
    };
    return { code: code ?? `HTTP_${status}`, message: `${(code && known[code]) || 'Inventory refused this bill.'}${said}` };
  }
  return null;
}

export type Outcome = 'DELIVERED' | 'EMPTY' | 'BUSY' | 'RETRY_LATER' | 'BLOCKED' | 'NOT_CONNECTED';

/** Send this shop's next waiting event, if it is its turn. */
export async function deliverNext(clientId: string): Promise<{ outcome: Outcome; sequence?: bigint }> {
  const leased = await prisma.$queryRaw<{ base_url: string; key_cipher: string; delivered_sequence: bigint; attempts: number }[]>`
    UPDATE inventory_links
       SET locked_until = (now() AT TIME ZONE 'UTC') + (${LEASE_MS} || ' milliseconds')::interval
     WHERE client_id = ${clientId}
       AND connected
       AND blocked_sequence IS NULL
       AND (locked_until IS NULL OR locked_until < (now() AT TIME ZONE 'UTC'))
       AND (next_attempt_at IS NULL OR next_attempt_at <= (now() AT TIME ZONE 'UTC'))
 RETURNING base_url, key_cipher, delivered_sequence, attempts`;
  const link = leased[0];
  if (!link) {
    const row = await prisma.inventoryLink.findUnique({ where: { clientId }, select: { connected: true, blockedSequence: true } });
    if (!row || !row.connected) return { outcome: 'NOT_CONNECTED' };
    if (row.blockedSequence) return { outcome: 'BLOCKED', sequence: row.blockedSequence };
    return { outcome: 'BUSY' };
  }

  const release = (data: Record<string, unknown>) =>
    prisma.inventoryLink.update({ where: { clientId }, data: { lockedUntil: null, ...data } });

  const event = await prisma.webhookEvent.findFirst({
    where: { clientId, eventType: { in: STOCK_EVENTS }, sequence: { gt: link.delivered_sequence } },
    orderBy: { sequence: 'asc' },
    select: { sequence: true, eventType: true, eventVersion: true, payload: true }
  });
  if (!event) {
    await release({});
    return { outcome: 'EMPTY' };
  }

  const reply = await call(
    { baseUrl: link.base_url, keyCipher: link.key_cipher },
    'POST', '/events',
    { eventType: event.eventType, eventVersion: event.eventVersion, sequence: Number(event.sequence), payload: event.payload }
  );

  if (reply.kind === 'ANSWERED' && reply.status >= 200 && reply.status < 300) {
    await release({ deliveredSequence: event.sequence, lastDeliveredAt: new Date(), attempts: 0, nextAttemptAt: null, lastError: null });
    return { outcome: 'DELIVERED', sequence: event.sequence };
  }

  const stop = reply.kind === 'ANSWERED' ? refusal(reply.status, reply.body) : null;
  if (stop) {
    await release({ blockedSequence: event.sequence, blockedCode: stop.code, blockedMessage: stop.message, lastError: stop.message });
    return { outcome: 'BLOCKED', sequence: event.sequence };
  }

  const attempts = Number(link.attempts) + 1;
  const why = reply.kind === 'UNREACHABLE' ? `Inventory could not be reached (${reply.reason}).` : `Inventory was busy (${reply.status}).`;
  await release({ attempts, nextAttemptAt: new Date(Date.now() + backoffFor(attempts)), lastError: why });
  return { outcome: 'RETRY_LATER', sequence: event.sequence };
}

/** Everything this shop has waiting, until the queue is empty or has to wait. */
export async function drain(clientId: string, max = 100) {
  let sent = 0;
  for (let i = 0; i < max; i++) {
    const r = await deliverNext(clientId);
    if (r.outcome !== 'DELIVERED') return { sent, stoppedBecause: r.outcome };
    sent++;
  }
  return { sent, stoppedBecause: 'LIMIT' as const };
}

/** One pass over every connected shop. */
export async function runOnce() {
  const links = await prisma.inventoryLink.findMany({ where: { connected: true, blockedSequence: null }, select: { clientId: true } });
  for (const l of links) {
    try { await drain(l.clientId); }
    catch (error) { console.error(`[inventory-link] delivery for ${l.clientId} failed:`, (error as Error).message); }
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Started by the server unless DISABLE_BACKGROUND_JOBS. A run never overlaps the one before it. */
export function startDeliveryLoop(everyMs = 15_000) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runOnce(); } finally { running = false; }
  }, everyMs);
  timer.unref();
}
