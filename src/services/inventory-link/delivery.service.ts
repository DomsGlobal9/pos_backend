import { prisma } from '../../lib/prisma';
import { confirmQrPayments } from './upi-qr.service';
import { call } from './client';
import { toInventory, readAnswer } from './wire';
import { confirmPendingHolds } from './holds.service';

/**
 * Sending the outbox to Inventory. POS-INV-006, -007, -008. Contract §4.
 *
 * TAKEN IN, THEN APPLIED (Inventory, 27 Sep). A sale is answered 202 ACCEPTED in about a second and
 * applied by Inventory's own worker a few seconds later. "Accepted" is durable -- Inventory has
 * written it down -- so the queue moves on at once, and an InventorySettlement row remembers to ask
 * `GET /events/status` how it ended. Applied: any notes go to the owner. Rejected: the queue goes
 * back to that bill and stops there, exactly as an immediate refusal does -- nothing slips past a
 * bill Inventory would not take.
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

// Everything Inventory is sent, in order. (The name is older than payment.updated.)
export const STOCK_EVENTS = ['sale.completed', 'sale.returned', 'sale.exchanged', 'payment.updated'];

/** How long a payment waits for its bill to be applied at Inventory before it is looked at again. */
const BILL_FIRST_MS = 5_000;

// Longer than the slowest answer Inventory gives (below), or a second instance could take the shop
// while the first is still waiting and send the same bill again -- harmless (ALREADY_APPLIED) but noisy.
const LEASE_MS = 150_000;
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
export const backoffFor = (attempts: number) => BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? 60 * 60_000;

/**
 * The number Inventory filed this event under -- which is what GET /events/status must be asked
 * for. Not always the outbox row's own invoiceNo:
 *
 *   payment.updated   its idempotencyKey. A kept order collects money more than once, so the bill
 *                     number cannot tell a repeat from a second instalment.
 *   sale.exchanged    the NEW bill. The outbox row is filed under the credit note (it is one act
 *                     to the POS), but Inventory keys the exchange on `exchangeNo`, which wire.ts
 *                     sends as newInvoiceNo. Asking for the credit note would 404 forever.
 */
function lookupKey(eventType: string, invoiceNo: string | null, payload: any): string {
  if (eventType === 'payment.updated') return String(payload?.idempotencyKey ?? invoiceNo ?? '');
  if (eventType === 'sale.exchanged') return String(payload?.newInvoiceNo ?? invoiceNo ?? '');
  return invoiceNo ?? '';
}

/** A refusal, in words: Inventory's own sentence names the item and the figures. */
function describe(code: string | null, detail: string | null) {
  const said = detail ? ` Inventory said: "${detail}"` : '';
  const known: Record<string, string> = {
    UNKNOWN_ITEM: 'An item on this bill is not in Inventory.',
    UNKNOWN_ORDER: 'Inventory has no record of the original bill.',
    QTY_EXCEEDS_SOLD: 'Inventory thinks more is being returned than was sold.',
    AMOUNT_MISMATCH: 'Inventory worked out a different refund.',
    BAD_PAYLOAD: 'Inventory could not take this bill.'
  };
  return `${(code && known[code]) || 'Inventory refused this bill.'}${said}`;
}

/** Why the queue stopped, as the owner will read it. Never a status code on its own. */
function refusal(status: number, body: any): { code: string; message: string } | null {
  const { answer: code, detail } = readAnswer(body);
  if (status === 401 || status === 403) {
    return { code: 'KEY_REFUSED', message: 'Inventory no longer accepts this till\'s key -- it was replaced or disconnected. Make a new one in Inventory (Settings → Money → POS (billing counter)) and connect again below.' };
  }
  // "Not now, try again" (contract §4, Inventory 27 Sep): a return that overtook its own sale while
  // Inventory is still applying the sale. A race, not a fault -- retried with the normal backoff.
  if (RETRYABLE.includes(code ?? '')) return null;
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return { code: code ?? `HTTP_${status}`, message: describe(code, detail) };
  }
  return null;
}

/** Answers that mean "wait and send the same event again", whatever the HTTP status. */
const RETRYABLE = ['SALE_NOT_YET_APPLIED'];

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
    select: { sequence: true, eventType: true, eventVersion: true, payload: true, invoiceNo: true }
  });
  if (!event) {
    await release({});
    return { outcome: 'EMPTY' };
  }

  /*
   * Money after the bill goes only once Inventory has APPLIED the bill. Accepted is not enough:
   * Inventory's worker settles a payment for a bill it has not recorded yet as UNKNOWN_ORDER and
   * does not wait (Inventory, 30 Sep). A UPI confirmed seconds after the sale would stop the queue.
   * Waiting here is not a failure -- no attempt is counted.
   */
  if (event.eventType === 'payment.updated' && event.invoiceNo) {
    const billPending = await prisma.inventorySettlement.findFirst({
      where: { clientId, invoiceNo: event.invoiceNo, settledAt: null }, select: { id: true }
    });
    // Ask about that one bill now, rather than wait for the next round of checks: after an outage a
    // queue can hold many bills each followed by its money, and each would otherwise wait a round.
    if (billPending && !(await billApplied(clientId, link, billPending.id, event.invoiceNo))) {
      await release({ nextAttemptAt: new Date(Date.now() + BILL_FIRST_MS) });
      return { outcome: 'RETRY_LATER', sequence: event.sequence };
    }
  }
  const payload = event.payload as Record<string, any>;
  const lookup = lookupKey(event.eventType, event.invoiceNo, payload);

  const reply = await call(
    { baseUrl: link.base_url, keyCipher: link.key_cipher },
    'POST', '/events',
    toInventory(event.eventType, event.payload),
    // Inventory's write is a dozen sequential statements to Singapore: 12 to 56 SECONDS measured on
    // 27 Sep. Giving up early is safe -- a timeout is retried and Inventory answers ALREADY_APPLIED if
    // it had committed -- but 90 s keeps that from being the normal case.
    90_000
  );

  const answer = reply.kind === 'ANSWERED' ? readAnswer(reply.body) : null;
  if (reply.kind === 'ANSWERED' && reply.status >= 200 && reply.status < 300 && (!answer?.answer || ['APPLIED', 'ALREADY_APPLIED', 'ACCEPTED'].includes(answer.answer))) {
    if (answer?.answer === 'ACCEPTED') {
      // Written down at Inventory, not applied yet. Ask how it ended in a few seconds.
      await prisma.inventorySettlement.upsert({
        where: { clientId_sequence: { clientId, sequence: event.sequence } },
        create: {
          clientId, sequence: event.sequence, invoiceNo: lookup, reference: answer.reference,
          acceptedAt: new Date(), nextCheckAt: new Date(Date.now() + CHECK_MS[0])
        },
        update: { reference: answer.reference ?? undefined, settledAt: null, status: 'QUEUED', detail: null, checks: 0, nextCheckAt: new Date(Date.now() + CHECK_MS[0]) }
      });
    } else {
      // Applied there and then (a resend of a bill Inventory already finished). Nothing left to ask.
      await prisma.inventorySettlement.updateMany({
        where: { clientId, sequence: event.sequence, settledAt: null },
        data: { status: 'APPLIED', settledAt: new Date() }
      });
      await noteWarnings(clientId, event.invoiceNo, answer?.warnings ?? []);
    }
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

/**
 * Has Inventory applied this bill yet? One status question, asked while the caller holds the lease.
 * APPLIED settles the row here. Anything else -- still queued, rejected, unreachable -- is left to
 * checkSettlements, which owns the rollback when a bill is rejected.
 */
async function billApplied(clientId: string, link: { base_url: string; key_cipher: string }, settlementId: string, invoiceNo: string) {
  const reply = await call(
    { baseUrl: link.base_url, keyCipher: link.key_cipher },
    'GET', `/events/status?invoiceNo=${encodeURIComponent(invoiceNo)}`, undefined, 15_000
  );
  if (reply.kind !== 'ANSWERED' || reply.status !== 200) return false;
  if (String(reply.body?.data?.status ?? '').toUpperCase() !== 'APPLIED') return false;
  await prisma.inventorySettlement.update({ where: { id: settlementId }, data: { status: 'APPLIED', detail: null, settledAt: new Date() } });
  await noteWarnings(clientId, invoiceNo, readAnswer(reply.body).warnings);
  return true;
}

/**
 * Accepted -- but Inventory may have noted something a person should settle: the till charged a
 * different GST rate than the product carries, or sold stock Inventory thought it did not have
 * (contract §4.4). Nothing stops for these; they are kept for the owner's Inventory link screen.
 */
async function noteWarnings(clientId: string, invoiceNo: string | null, warnings: string[]) {
  const fresh = warnings
    .filter(w => w.trim().length > 0)
    .map(text => ({ at: new Date().toISOString(), document: invoiceNo, text: text.trim() }));
  if (fresh.length === 0) return;
  const row = await prisma.inventoryLink.findUnique({ where: { clientId }, select: { recentWarnings: true } });
  const before = Array.isArray(row?.recentWarnings) ? (row!.recentWarnings as any[]) : [];
  await prisma.inventoryLink.update({ where: { clientId }, data: { recentWarnings: [...fresh.reverse(), ...before].slice(0, 30) } });
}

// Soon at first -- a sale usually applies in seconds -- then less often. An outage at Inventory
// can last minutes; asking every five seconds through it helps nobody.
const CHECK_MS = [5_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
// checks = how many times we have asked; the 5 s wait before the first ask is set at acceptance.
const checkAfter = (checks: number) => CHECK_MS[Math.min(checks, CHECK_MS.length - 1)];

/**
 * Ask Inventory how accepted bills ended. Under the same lease as sending, so two server instances
 * never both roll the queue back for the same rejection.
 */
export async function checkSettlements(clientId: string, max = 8): Promise<{ checked: number; applied: number; rejected: number }> {
  const result = { checked: 0, applied: 0, rejected: 0 };
  const due = await prisma.inventorySettlement.count({ where: { clientId, settledAt: null, nextCheckAt: { lte: new Date() } } });
  if (due === 0) return result;

  const leased = await prisma.$queryRaw<{ base_url: string; key_cipher: string }[]>`
    UPDATE inventory_links
       SET locked_until = (now() AT TIME ZONE 'UTC') + (${LEASE_MS} || ' milliseconds')::interval
     WHERE client_id = ${clientId}
       AND connected
       AND (locked_until IS NULL OR locked_until < (now() AT TIME ZONE 'UTC'))
 RETURNING base_url, key_cipher`;
  const link = leased[0];
  if (!link) return result;

  try {
    const rows = await prisma.inventorySettlement.findMany({
      where: { clientId, settledAt: null, nextCheckAt: { lte: new Date() } },
      orderBy: { sequence: 'asc' },
      take: max
    });
    for (const row of rows) {
      const reply = await call(
        { baseUrl: link.base_url, keyCipher: link.key_cipher },
        'GET', `/events/status?invoiceNo=${encodeURIComponent(row.invoiceNo)}`, undefined, 15_000
      );
      result.checked++;
      const checks = row.checks + 1;
      const later = (detail?: string) => prisma.inventorySettlement.update({
        where: { id: row.id },
        data: { checks, nextCheckAt: new Date(Date.now() + checkAfter(checks)), ...(detail !== undefined ? { detail } : {}) }
      });

      // Unreachable or busy: every other bill would get the same. Try them all again later.
      if (reply.kind === 'UNREACHABLE' || reply.status >= 500 || reply.status === 401 || reply.status === 403) {
        await later();
        break;
      }
      if (reply.status === 404) {
        // Accepted, yet unknown: Inventory's queue row should exist. Keep asking, and say so.
        await later(`Inventory accepted ${row.invoiceNo} but has no record of it yet.`);
        continue;
      }
      const data = reply.body?.data ?? {};
      const status = String(data.status ?? '').toUpperCase();
      if (!data.settledAt && status !== 'APPLIED' && status !== 'REJECTED') {
        await prisma.inventorySettlement.update({
          where: { id: row.id },
          data: { checks, status: status || row.status, nextCheckAt: new Date(Date.now() + checkAfter(checks)) }
        });
        continue;
      }

      if (status === 'REJECTED') {
        const { answer, detail } = readAnswer(reply.body);
        const code = answer && answer !== 'REJECTED' ? answer : 'REJECTED';
        const message = describe(code, detail);
        await prisma.inventorySettlement.update({ where: { id: row.id }, data: { checks, status: 'REJECTED', detail: message, settledAt: new Date() } });
        /*
         * Back to this bill, and stop. The cursor goes to just before it, so Retry (after the owner
         * fixes the item in Inventory) sends THIS bill again; anything after it that Inventory had
         * already taken in is sent again too and answered ALREADY_APPLIED or the same reference.
         * An earlier block, if there is one, stays: the queue stops at the first problem.
         */
        await prisma.$executeRaw`
          UPDATE inventory_links
             SET delivered_sequence = LEAST(delivered_sequence, ${row.sequence} - 1),
                 blocked_code    = CASE WHEN blocked_sequence IS NULL OR blocked_sequence > ${row.sequence} THEN ${code} ELSE blocked_code END,
                 blocked_message = CASE WHEN blocked_sequence IS NULL OR blocked_sequence > ${row.sequence} THEN ${message} ELSE blocked_message END,
                 last_error      = CASE WHEN blocked_sequence IS NULL OR blocked_sequence > ${row.sequence} THEN ${message} ELSE last_error END,
                 blocked_sequence = LEAST(COALESCE(blocked_sequence, ${row.sequence}), ${row.sequence})
           WHERE client_id = ${clientId}`;
        result.rejected++;
        continue;
      }

      await prisma.inventorySettlement.update({ where: { id: row.id }, data: { checks, status: 'APPLIED', detail: null, settledAt: new Date() } });
      await noteWarnings(clientId, row.invoiceNo, readAnswer(reply.body).warnings);
      /*
       * The customer's points on this bill, now that Inventory has settled it: what they earned, what
       * they spent, and where that left them. Printed on the digital receipt and on any reprint; the
       * first paper copy has gone already. Nothing earned or spent prints nothing.
       */
      /*
       * A COLLECTION is checked by its own key ("INV/..:pay:<key>"), but the points belong to the
       * bill. Inventory earns a credit sale's points as the money comes in (8 Oct), so after each
       * collection the bill's figure is asked for again -- by the key alone it matched no bill and
       * the till kept the at-sale figure for ever.
       */
      const billNo = row.invoiceNo.split(':pay:')[0];
      let pts = data.points;
      if (billNo !== row.invoiceNo) {
        const bill = await call(
          { baseUrl: link.base_url, keyCipher: link.key_cipher },
          'GET', `/events/status?invoiceNo=${encodeURIComponent(billNo)}`, undefined, 15_000
        );
        pts = bill.kind === 'ANSWERED' && bill.status < 300 ? (bill.body?.data?.points ?? null) : null;
      }
      if (pts && (Number(pts.earned) > 0 || Number(pts.used) > 0)) {
        await prisma.sale.updateMany({
          where: { clientId, invoiceNo: billNo },
          data: {
            pointsEarned: Number(pts.earned) || 0,
            pointsUsed: Number(pts.used) || 0,
            pointsBalanceAfter: Number.isInteger(pts.balanceAfter) ? pts.balanceAfter : null
          }
        });
      }
      result.applied++;
    }
  } finally {
    await prisma.inventoryLink.update({ where: { clientId }, data: { lockedUntil: null } });
  }
  return result;
}

/**
 * Tell Inventory about the bills the owner left out. Contract: `document.skipped` (Inventory, 5 Oct).
 *
 * Leaving a bill out is the way past a refusal nobody can fix -- the queue moves on and the shop
 * keeps selling. What it leaves behind is a hole: the stock on that bill never left Inventory's
 * books and its day book is short by it, and until now Inventory was never told. The POS said so
 * honestly on its own screen ("Inventory has not been told") and that was the whole of it.
 *
 * RECORDED, NEVER APPLIED, at Inventory's end: no stock moves, no order, no money. It is how
 * Inventory knows its books are short, and the owner sees it under Settings -> Money -> POS, where
 * it stays even after the till is disconnected, because the gap stays.
 *
 * THE NUMBER SENT IS THE ONE INVENTORY FILED UNDER, not the one the owner read. `skip.document` is
 * the bill or credit note as it appeared on screen; for an exchange Inventory keyed the event on
 * the NEW bill and for a payment on its idempotencyKey. Sending the owner's number would leave a
 * marker against nothing. Same lookupKey as the settlement questions, for the same reason.
 *
 * Answered synchronously -- 200 APPLIED or ALREADY_APPLIED, never 202, nothing to poll. A repeat is
 * ALREADY_APPLIED, so sending twice is safe and the cursor here is simply `reportedAt`.
 *
 * ponytail: a refusal is retried on the next pass, every 15 s, and only logged. That is deliberate
 * while the only way to earn one is a contract drift -- noisy logs are the right failure mode for
 * that. If it ever becomes an ordinary answer, give the row a reportAttemptAt and back it off.
 */
export async function reportSkips(clientId: string, max = 5) {
  const waiting = await prisma.inventorySkip.findMany({
    where: { clientId, reportedAt: null }, orderBy: { sequence: 'asc' }, take: max
  });
  if (waiting.length === 0) return { reported: 0 };

  const link = await prisma.inventoryLink.findUnique({
    where: { clientId }, select: { connected: true, baseUrl: true, keyCipher: true }
  });
  if (!link?.connected) return { reported: 0 };

  let reported = 0;
  for (const skip of waiting) {
    const event = await prisma.webhookEvent.findFirst({
      where: { clientId, sequence: skip.sequence },
      select: { eventType: true, invoiceNo: true, payload: true }
    });
    // The event is gone, so its number cannot be worked out. The owner's own number is the best
    // left, and a marker against the right bill matters more than a perfect key.
    const document = event
      ? lookupKey(event.eventType, event.invoiceNo, event.payload as any)
      : skip.document;

    const reply = await call({ baseUrl: link.baseUrl, keyCipher: link.keyCipher }, 'POST', '/events', {
      kind: 'document.skipped',
      document,
      /*
       * The number the OWNER read, when it is not the one Inventory matches on -- the credit note
       * for an exchange. Inventory shows it beside the key as "INV/... (credit note CN/... at the
       * till)", so the owner can tie the line in its list to the bill they actually left out
       * (Inventory, 6 Oct). Only sent when the two differ; the same number twice would just be
       * noise on that screen.
       */
      ...(skip.document && skip.document !== document ? { shownAs: skip.document } : {}),
      eventType: skip.eventType,
      reason: skip.reason,
      ...(skip.skippedBy ? { skippedBy: skip.skippedBy } : {}),
      skippedAt: skip.skippedAt.toISOString(),
      ...(skip.refusedCode ? { refusedCode: skip.refusedCode } : {}),
      ...(skip.refusedText ? { refusedText: skip.refusedText } : {})
    }, 30_000);

    if (reply.kind === 'UNREACHABLE') break;   // every other one would meet the same; try later
    const answer = readAnswer(reply.body).answer;
    if (reply.status >= 200 && reply.status < 300 && (!answer || ['APPLIED', 'ALREADY_APPLIED'].includes(answer))) {
      await prisma.inventorySkip.update({ where: { id: skip.id }, data: { reportedAt: new Date() } });
      reported++;
      continue;
    }
    console.error(`[inventory-link] Inventory would not record ${document} as left out (${reply.status}): ${readAnswer(reply.body).detail ?? ''}`);
  }
  return { reported };
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

/** One pass over every connected shop: send what is waiting, then ask how accepted bills ended. */
export async function runOnce() {
  const links = await prisma.inventoryLink.findMany({ where: { connected: true }, select: { clientId: true, blockedSequence: true } });
  for (const l of links) {
    try {
      // Holds first: a confirm is never left waiting behind the sale queue (contract §10).
      await confirmPendingHolds(l.clientId);
      await confirmQrPayments(l.clientId);
      if (l.blockedSequence === null) await drain(l.clientId);
      // Even a stopped queue has bills Inventory accepted before it stopped. Their endings still count.
      await checkSettlements(l.clientId);
      // And the bills the owner left out: Inventory's books are short by them until it is told.
      await reportSkips(l.clientId);
    } catch (error) {
      console.error(`[inventory-link] delivery for ${l.clientId} failed:`, (error as Error).message);
    }
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
    /*
     * Caught, always. runOnce's first read (the list of connected shops) sits outside its per-shop
     * catch, and the database connection does drop now and then (Supabase's pooler closes idle ones).
     * Uncaught, that one rejection took the whole server down -- till and all -- seen 30 Sep. The next
     * pass, 15 seconds later, simply tries again.
     */
    try { await runOnce(); }
    catch (error) { console.error('[inventory-link] pass failed:', (error as Error).message); }
    finally { running = false; }
  }, everyMs);
  timer.unref();
}
