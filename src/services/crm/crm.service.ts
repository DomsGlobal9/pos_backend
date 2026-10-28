import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';

/**
 * TELLING SCALEEZY CRM WHAT ONLY THE COUNTER KNOWS (28 Oct, owner's go; CRM's inbox, D:\villy\crm).
 *
 * A sale reaches CRM through Inventory, never twice (CRM's plan rule). What Inventory never sees is a
 * customer made or changed at the counter before they buy, and the marketing consent the cashier ticks --
 * without it CRM cannot lawfully send that customer an offer. So the till sends exactly two kinds:
 *
 *   customer.upserted   the customer as the till holds them now, on every create or change
 *   consent.changed     granted, once, when the cashier ticks it (the till never withdraws)
 *
 * Only for a shop linked to Inventory: CRM knows a shop by Inventory's id for it (platformClientId), and
 * a standalone till has none. Balances are NOT sent: in a linked shop they are Inventory's.
 *
 * AN OUTBOX, NOT A CALL. The counter writes a row and is done; a loop sends rows in order, signed with
 * this till's secret (HMAC-SHA256 of the exact bytes, as CRM's inbox checks). CRM down: retried with
 * backoff. CRM refusing one event as malformed: that one is set aside with CRM's sentence and the rest go
 * on. A wrong secret: everything waits an hour and the owner's Inventory link page says so.
 */

const BATCH = 100;
const KINDS = ['customer.upserted', 'consent.changed'] as const;
export const crmConfigured = () => Boolean(env.CRM_BASE_URL && env.CRM_SOURCE_SECRET);

type CustomerRow = {
  id: string; phone: string; name: string | null; gstin: string | null; address: string | null;
  marketingConsent: boolean; consentAt: Date | null; createdAt: Date; updatedAt: Date;
};
const CUSTOMER = { id: true, phone: true, name: true, gstin: true, address: true, marketingConsent: true, consentAt: true, createdAt: true, updatedAt: true } as const;

async function linkedShop(clientId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const link = await db.inventoryLink.findUnique({ where: { clientId }, select: { connected: true, platformClientId: true } });
  return link?.connected && link.platformClientId ? link.platformClientId : null;
}

function rowsFor(c: CustomerRow, byName: string | null) {
  const rows: { kind: string; payload: object; idempotencyKey: string; occurredAt: Date }[] = [{
    kind: 'customer.upserted',
    idempotencyKey: `pos:customer:${c.id}:${c.updatedAt.getTime()}`,
    occurredAt: c.updatedAt,
    payload: {
      customerId: c.id,
      // No name: sent as none (CRM 68c13ce), so CRM matches them on the phone alone and keeps the name it has.
      name: c.name?.trim() || null,
      phone: c.phone,
      gstNumber: c.gstin,
      customerType: 'REGISTERED',
      addresses: c.address ? [{ line: c.address, isDefault: true }] : [],
      createdAt: c.createdAt.toISOString()
    }
  }];
  if (c.marketingConsent) {
    const at = c.consentAt ?? c.updatedAt;
    rows.push({
      kind: 'consent.changed',
      idempotencyKey: `pos:consent:${c.id}`,
      // After its customer, always: CRM files consent against a customer it already has.
      occurredAt: new Date(Math.max(at.getTime(), c.updatedAt.getTime())),
      payload: { customerId: c.id, ref: `pos-consent-${c.id}`, channel: 'whatsapp', purpose: 'offers', granted: true, byName, how: 'counter', at: at.toISOString() }
    });
  }
  return rows;
}

type Db = Prisma.TransactionClient | typeof prisma;

async function queue(db: Db, clientId: string, rows: ReturnType<typeof rowsFor>) {
  // One at a time, in order, so createdAt keeps a customer ahead of their consent.
  for (const r of rows) {
    await db.crmOutbox.upsert({
      where: { clientId_idempotencyKey: { clientId, idempotencyKey: r.idempotencyKey } },
      update: {},
      create: { clientId, kind: r.kind, payload: r.payload as any, idempotencyKey: r.idempotencyKey, occurredAt: r.occurredAt }
    });
  }
}

/**
 * Called IN THE SAME TRANSACTION as the customer's create or change (PLAN-crm §14 F1, 28 Oct): the row
 * for CRM and the customer are saved together or not at all, so a crash between the two can never leave a
 * change CRM is not told of. The backfill runs once per shop and would not catch it.
 */
export async function customerChanged(db: Db, clientId: string, customerId: string, byName: string | null = null) {
  if (!crmConfigured() || !(await linkedShop(clientId, db))) return;
  const c = await db.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: CUSTOMER });
  if (c) await queue(db, clientId, rowsFor(c, byName));
}

/** The first time a shop is sent to: every customer it already has, then their consents. */
export async function backfill(clientId: string) {
  // A marker row, not "is the outbox empty": a customer changed before the first send must not stop
  // every older customer from going. The marker is never sent (it is not one of KINDS).
  const MARK = 'pos:backfill';
  if (await prisma.crmOutbox.findUnique({ where: { clientId_idempotencyKey: { clientId, idempotencyKey: MARK } }, select: { id: true } })) return 0;
  let n = 0;
  let after: string | undefined;
  for (;;) {
    const page = await prisma.customer.findMany({
      where: { clientId, deletedAt: null }, select: CUSTOMER, orderBy: { id: 'asc' }, take: 500,
      ...(after ? { cursor: { id: after }, skip: 1 } : {})
    });
    if (!page.length) break;
    for (const c of page) { await queue(prisma, clientId, rowsFor(c, null)); n++; }
    after = page.at(-1)!.id;
  }
  await prisma.crmOutbox.create({ data: { clientId, kind: 'backfill.done', payload: { customers: n }, idempotencyKey: MARK, occurredAt: new Date(), sentAt: new Date() } });
  return n;
}

export type Transport = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: any } | null>;
const http: Transport = async (url, body, headers) => {
  try {
    const res = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    let parsed: any = null;
    try { parsed = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
  } catch {
    return null;
  }
};
let transport: Transport = http;
/** For the test scripts only: a stand-in CRM. */
export function useCrmTransport(t: Transport | null) { transport = t ?? http; }

const backoff = (attempts: number) => Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7));

/** One batch for one shop. Returns what happened, for the loop and the tests. */
export async function sendCrm(clientId: string): Promise<{ sent: number; setAside: number; outcome: string }> {
  if (!crmConfigured()) return { sent: 0, setAside: 0, outcome: 'NOT_CONFIGURED' };
  const shop = await linkedShop(clientId);
  if (!shop) return { sent: 0, setAside: 0, outcome: 'NOT_LINKED' };
  await backfill(clientId);
  const now = new Date();
  const rows = await prisma.crmOutbox.findMany({
    where: { clientId, sentAt: null, setAside: false, kind: { in: [...KINDS] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }], take: BATCH
  });
  if (!rows.length) return { sent: 0, setAside: 0, outcome: 'NOTHING' };

  const body = JSON.stringify({
    events: rows.map(r => ({
      id: r.id, source: 'pos', clientId: shop, kind: r.kind, version: 1,
      occurredAt: r.occurredAt.toISOString(), idempotencyKey: r.idempotencyKey, payload: r.payload
    }))
  });
  // Signed over the time AND the body (CRM, 28 Oct; Inventory's webhook form): a copy replayed later than
  // five minutes is refused. The time is taken fresh at every attempt, so a retry is never stale.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', env.CRM_SOURCE_SECRET!).update(`${timestamp}.`).update(body).digest('hex');
  const reply = await transport(`${env.CRM_BASE_URL!.replace(/\/+$/, '')}/api/v1/inbox/events`, body, {
    'Content-Type': 'application/json', 'X-CRM-Source': 'pos', 'X-CRM-Timestamp': String(timestamp), 'X-CRM-Signature': `sha256=${signature}`
  });
  const ids = rows.map(r => r.id);

  if (reply && (reply.status === 202 || reply.status === 200)) {
    await prisma.crmOutbox.updateMany({ where: { id: { in: ids } }, data: { sentAt: new Date(), lastError: null, nextAttemptAt: null } });
    return { sent: ids.length, setAside: 0, outcome: 'SENT' };
  }
  if (reply && reply.status === 400 && Number.isInteger(reply.body?.index) && rows[reply.body.index]) {
    // CRM refuses the whole batch for one event and says which. Set that one aside; the rest go next pass.
    const bad = rows[reply.body.index];
    await prisma.crmOutbox.update({ where: { id: bad.id }, data: { setAside: true, lastError: String(reply.body?.message ?? 'CRM did not accept it.').slice(0, 300) } });
    console.error(`[crm] ${clientId}: CRM refused ${bad.kind} ${bad.idempotencyKey}: ${reply.body?.message}`);
    return { sent: 0, setAside: 1, outcome: 'SET_ASIDE' };
  }
  // CRM answers a good signature outside its five minutes with 400 reason "stale_timestamp" (CRM fda787a):
  // this server's clock, not its key and not a bad event. Tried again in a minute and named as a clock
  // problem, never the hour a wrong key waits. 401 means only a wrong key. The set-aside above takes only a
  // 400 that names an event (index); this one names none.
  const clock = reply?.status === 400 && reply.body?.reason === 'stale_timestamp';
  const badKey = reply?.status === 401 && !clock;
  const why = !reply ? 'CRM could not be reached.'
    : clock ? 'CRM says this server\'s clock is off by more than 5 minutes. Ask ScaleEzy support to check the server time.'
    : badKey ? 'CRM does not know this till\'s key (CRM_SOURCE_SECRET). Ask ScaleEzy support.'
    : `CRM answered ${reply.status}: ${String(reply.body?.message ?? '').slice(0, 200)}`;
  const attempts = (rows[0].attempts ?? 0) + 1;
  const wait = badKey ? 60 * 60_000 : clock ? 60_000 : backoff(attempts);
  await prisma.crmOutbox.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 }, lastError: why, nextAttemptAt: new Date(Date.now() + wait) } });
  return { sent: 0, setAside: 0, outcome: badKey ? 'BAD_KEY' : clock ? 'CLOCK' : 'RETRY' };
}

/** For the owner's Inventory link page: is the counter's news reaching CRM? */
export async function crmStatus(clientId: string) {
  if (!crmConfigured()) return { configured: false };
  const [waiting, setAside, last, problem] = await Promise.all([
    prisma.crmOutbox.count({ where: { clientId, sentAt: null, setAside: false } }),
    prisma.crmOutbox.count({ where: { clientId, setAside: true } }),
    prisma.crmOutbox.findFirst({ where: { clientId, sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
    prisma.crmOutbox.findFirst({ where: { clientId, sentAt: null, lastError: { not: null } }, orderBy: { createdAt: 'desc' }, select: { lastError: true } })
  ]);
  return { configured: true, waiting, setAside, lastSentAt: last?.sentAt ?? null, problem: problem?.lastError ?? null };
}

/** One pass over every linked shop. */
export async function runCrmOnce() {
  if (!crmConfigured()) return;
  const links = await prisma.inventoryLink.findMany({ where: { connected: true, platformClientId: { not: null } }, select: { clientId: true } });
  for (const l of links) {
    try {
      // Drain what is due, a few batches a pass; a set-aside event lets the rest go straight after.
      for (let i = 0; i < 5; i++) {
        const r = await sendCrm(l.clientId);
        if (r.outcome !== 'SENT' && r.outcome !== 'SET_ASIDE') break;
      }
    } catch (error) {
      console.error(`[crm] sending for ${l.clientId} failed:`, (error as Error).message);
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Started by the server unless DISABLE_BACKGROUND_JOBS. A pass never overlaps the one before. */
export function startCrmLoop(everyMs = 30_000) {
  if (timer || !crmConfigured()) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runCrmOnce(); }
    catch (error) { console.error('[crm] pass failed:', (error as Error).message); }
    finally { running = false; }
  }, everyMs);
  timer.unref();
}
