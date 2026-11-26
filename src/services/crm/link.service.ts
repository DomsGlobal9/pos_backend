import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { canCallCrm, serviceToken } from './service-token';
import { applyCrmView } from './events.service';
import { badRequest, unavailable } from '../../utils/httpError';

/**
 * EVERY TILL CUSTOMER, LINKED TO CRM'S ONE PERSON (19 Nov, owner: CRM owns who a customer is).
 *
 * The till saves a customer exactly as it always has -- at the counter, offline, in its own transaction --
 * and never waits for CRM. In that same transaction it writes one row here (customerChanged, crm.service).
 * A background pass then asks CRM, through CRM's service API:
 *
 *   POST /api/v1/service/customers/find-or-add   (scope crm:customer:create)
 *   { phone, name?, walkIn: true, externalId: <the till's own id for them> }
 *   -> { customer: { id, name, phone, ... }, created, matched }
 *
 * Safe to ask again: the same number in any format, or the same externalId, always comes back as the same
 * person. CRM's id is kept here, and CRM's record of who they are fills in the till's copy.
 *
 * Only for a shop linked to Inventory (CRM knows a shop by Inventory's id for it), and only once CRM is on
 * for that shop: CRM answers 404 "has not switched CRM on" and the shop is asked again a day later. CRM down
 * or slow: tried again with a growing wait. Nothing here can stop a sale.
 */
const BATCH = 50;
const DAY = 24 * 60 * 60_000;
const backoff = (attempts: number) => Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7));

type Db = Prisma.TransactionClient | typeof prisma;

/** The shop as CRM knows it (Inventory's id for it), or null: a till not linked to Inventory never goes to CRM. */
export async function crmShopOf(clientId: string, db: Db = prisma): Promise<string | null> {
  const [link, shop] = await Promise.all([
    db.inventoryLink.findUnique({ where: { clientId }, select: { connected: true, platformClientId: true } }),
    db.shopSettings.findUnique({ where: { clientId }, select: { platformClientId: true, platformModules: true, switchedOffAt: true } })
  ]);
  if (shop?.switchedOffAt) return null;
  // One-switch onboarding (26 Nov): the Console says which modules the client has. CRM on: its shop is the client's
  // platform id, Inventory or not. CRM off: nothing goes to CRM.
  if (shop && shop.platformModules.length) {
    return shop.platformModules.includes('crm') ? (shop.platformClientId ?? link?.platformClientId ?? null) : null;
  }
  // A shop from before the Console: CRM through Inventory's link, as it always was.
  return link?.connected && link.platformClientId ? link.platformClientId : null;
}

/** Called in the customer's own transaction: one row to link, if this shop goes to CRM at all. */
export async function queueLink(db: Db, clientId: string, customerId: string) {
  if (!canCallCrm() || !(await crmShopOf(clientId, db))) return;
  await db.crmCustomerLink.upsert({
    where: { customerId },
    // Already linked: CRM follows its own record from here; a changed name reaches it in its own feed.
    update: {},
    create: { customerId, clientId }
  });
}

/** Customers the till had before linking began: a row each, a page at a time. */
async function catchUp(clientId: string, max = 200) {
  const missing = await prisma.customer.findMany({
    where: { clientId, deletedAt: null, mergedIntoId: null, crmLink: null },
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: max
  });
  if (missing.length) await prisma.crmCustomerLink.createMany({ data: missing.map(m => ({ customerId: m.id, clientId })), skipDuplicates: true });
  return missing.length;
}

export type CrmCall = (path: string, token: string, body: unknown, method?: 'POST' | 'PATCH') => Promise<{ status: number; body: any; retryAfter?: number } | null>;
const http: CrmCall = async (path, token, body, method = 'POST') => {
  try {
    const res = await fetch(`${env.CRM_BASE_URL!.replace(/\/+$/, '')}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(method === 'PATCH' ? 5_000 : 10_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    let parsed: any = null;
    try { parsed = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, retryAfter: Number(res.headers.get('retry-after')) || undefined };
  } catch {
    return null;
  }
};
let call: CrmCall = http;
/** For the test scripts only: a stand-in CRM. */
export function useCrmCall(c: CrmCall | null) { call = c ?? http; }

const NOT_ON = 'CRM is not switched on for this shop. Asked again tomorrow.';

/** One pass for one shop. Returns what happened, for the loop and the tests. */
export async function linkShop(clientId: string): Promise<{ linked: number; outcome: string }> {
  if (!canCallCrm()) return { linked: 0, outcome: 'NOT_CONFIGURED' };
  const shop = await crmShopOf(clientId);
  if (!shop) return { linked: 0, outcome: 'NOT_LINKED' };
  await catchUp(clientId);
  const now = new Date();
  const due = await prisma.crmCustomerLink.findMany({
    where: { clientId, crmCustomerId: null, nextTryAt: { lte: now } },
    include: { customer: { select: { id: true, phone: true, name: true, deletedAt: true, mergedIntoId: true } } },
    orderBy: { nextTryAt: 'asc' }, take: BATCH
  });
  let linked = 0;
  for (const row of due) {
    const c = row.customer;
    // Erased or joined into another since: nothing to link.
    if (c.deletedAt || c.mergedIntoId) { await prisma.crmCustomerLink.delete({ where: { customerId: c.id } }).catch(() => {}); continue; }
    const token = serviceToken(shop, ['crm:customer:create']);
    const reply = await call('/api/v1/service/customers/find-or-add', token, { phone: c.phone, ...(c.name?.trim() ? { name: c.name.trim() } : {}), walkIn: true, externalId: c.id });
    const later = (ms: number, problem: string, counts = true) => prisma.crmCustomerLink.update({
      where: { customerId: c.id }, data: { lastProblem: problem.slice(0, 300), nextTryAt: new Date(Date.now() + ms), ...(counts ? { attempts: { increment: 1 } } : {}) }
    });

    const crmId = reply?.body?.data?.customer?.id ?? reply?.body?.customer?.id;
    if (reply && (reply.status === 200 || reply.status === 201) && typeof crmId === 'string') {
      await prisma.$transaction(async tx => {
        await tx.crmCustomerLink.update({ where: { customerId: c.id }, data: { crmCustomerId: crmId, linkedAt: new Date(), lastProblem: null } });
        await applyCrmView(tx, clientId, c.id, reply.body?.data?.customer ?? reply.body?.customer);
      });
      linked++;
      continue;
    }
    if (reply?.status === 404 && /not switched CRM on/i.test(String(reply.body?.message ?? ''))) {
      // Not a fault: the whole shop waits a day, without counting it against anyone.
      await prisma.crmCustomerLink.updateMany({ where: { clientId, crmCustomerId: null }, data: { lastProblem: NOT_ON, nextTryAt: new Date(Date.now() + DAY) } });
      return { linked, outcome: 'NOT_ON_CRM' };
    }
    if (reply?.status === 401 || reply?.status === 403) {
      await prisma.crmCustomerLink.updateMany({ where: { clientId, crmCustomerId: null }, data: { lastProblem: `CRM does not accept this till's key yet: ${String(reply.body?.message ?? '').slice(0, 200)}`, nextTryAt: new Date(Date.now() + 60 * 60_000) } });
      return { linked, outcome: 'BAD_KEY' };
    }
    if (reply?.status === 429) {
      await later((reply.retryAfter ?? 5) * 1000, 'CRM asked the till to slow down.', false);
      return { linked, outcome: 'SLOW_DOWN' };
    }
    if (reply?.status === 409) { await later(30 * DAY, String(reply.body?.message ?? 'CRM will not take this customer back.')); continue; }
    if (reply?.status === 400) { await later(DAY, `CRM did not accept them: ${String(reply.body?.message ?? '')}`); continue; }
    // Down, slow, or something unexpected: back off, and leave the rest for the next pass.
    await later(backoff(row.attempts + 1), reply ? `CRM answered ${reply.status}.` : 'CRM could not be reached.');
    return { linked, outcome: 'RETRY' };
  }
  return { linked, outcome: due.length ? 'DONE' : 'NOTHING' };
}

/**
 * A NAME CHANGED AT THE TILL, FOR A CUSTOMER CRM OWNS (19 Nov, CRM: a module's copy only fills blanks once
 * CRM owns the shop's customers, so a rename made only here would be put back by CRM's next change).
 *
 * For a linked customer the new name goes to CRM first (PATCH /api/v1/service/customers/:id, scope
 * crm:customer:update) and the till saves it only once CRM has it. CRM unreachable: nothing is changed, and
 * the person is told so in one sentence -- a name that differs here and in CRM would quietly be undone.
 * A customer not linked yet, a till not linked to Inventory, or a shop without CRM: the till's own as before.
 * The GSTIN, address, note and credit limit are the till's alone and never go this way.
 */
export async function renameAtCrm(clientId: string, customerId: string, name: string | null): Promise<'CRM' | 'HERE'> {
  if (!canCallCrm()) return 'HERE';
  const shop = await crmShopOf(clientId);
  const link = shop ? await prisma.crmCustomerLink.findUnique({ where: { customerId }, select: { crmCustomerId: true } }) : null;
  if (!shop || !link?.crmCustomerId) return 'HERE';
  const reply = await call(`/api/v1/service/customers/${encodeURIComponent(link.crmCustomerId)}`, serviceToken(shop, ['crm:customer:update']), { name }, 'PATCH');
  if (reply && reply.status >= 200 && reply.status < 300) return 'CRM';
  // CRM is not on for the shop after all: the till's own, as for any shop without CRM.
  if (reply?.status === 404 && /not switched CRM on/i.test(String(reply.body?.message ?? ''))) return 'HERE';
  // The till may not change names in CRM yet (the scope is not given): as before, rather than block every edit.
  if (reply?.status === 401 || reply?.status === 403) {
    console.error(`[crm] a rename went only to the till: CRM refused the till's key or scope (${reply.status}).`);
    return 'HERE';
  }
  // CRM no longer knows the person the till linked (removed or replaced there): the link is stale. It is
  // dropped, the name is the till's to save, and the save queues a fresh link (find-or-add, by number).
  if (reply?.status === 404) {
    await prisma.crmCustomerLink.deleteMany({ where: { customerId } });
    return 'HERE';
  }
  if (reply && (reply.status === 400 || reply.status === 409)) {
    throw badRequest(String(reply.body?.message ?? 'ScaleEzy CRM did not accept that change.'), { code: 'CRM_REFUSED' });
  }
  throw unavailable('Couldn\'t reach ScaleEzy CRM, so nothing was changed. Try again in a minute.', { code: 'CRM_UNREACHABLE' });
}

/**
 * For the owner's Inventory link page (19 Nov): are this till's customers linked to CRM? So the switch-on
 * can be seen working from the till itself, without anyone reading a database.
 */
export async function crmLinkStatus(clientId: string) {
  if (!canCallCrm() || !(await crmShopOf(clientId))) return { on: false as const };
  const [linked, waiting, problem, lastLinked, events] = await Promise.all([
    prisma.crmCustomerLink.count({ where: { clientId, crmCustomerId: { not: null } } }),
    prisma.crmCustomerLink.count({ where: { clientId, crmCustomerId: null } }),
    prisma.crmCustomerLink.findFirst({ where: { clientId, crmCustomerId: null, lastProblem: { not: null } }, orderBy: { nextTryAt: 'desc' }, select: { lastProblem: true } }),
    prisma.crmCustomerLink.findFirst({ where: { clientId, linkedAt: { not: null } }, orderBy: { linkedAt: 'desc' }, select: { linkedAt: true } }),
    // CRM's events for this shop: the newest one tells the owner CRM's changes are arriving.
    crmShopOf(clientId).then(shop => shop ? prisma.crmInboundEvent.findFirst({ where: { clientId: shop }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }) : null)
  ]);
  /*
   * Shown only for a shop that USES ScaleEzy CRM (the owner, 20 Nov: a module's screens appear only when it is
   * connected). Proof is a customer CRM linked, or a change CRM sent; and never while CRM's latest answer is
   * "not switched on for this shop".
   */
  const usesCrm = problem?.lastProblem !== NOT_ON && (linked > 0 || !!events);
  if (!usesCrm) return { on: false as const };
  return { on: true as const, linked, waiting, problem: problem?.lastProblem ?? null, lastLinkedAt: lastLinked?.linkedAt ?? null, lastEventAt: events?.receivedAt ?? null, eventsOn: Boolean(env.CRM_WEBHOOK_SECRET) };
}

/** One pass over every shop linked to Inventory. */
export async function runLinkOnce() {
  if (!canCallCrm()) return;
  const shops = await prisma.inventoryLink.findMany({ where: { connected: true, platformClientId: { not: null } }, select: { clientId: true } });
  for (const s of shops) {
    try { await linkShop(s.clientId); }
    catch (error) { console.error(`[crm] linking customers for ${s.clientId} failed:`, (error as Error).message); }
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;
/** Started by the server unless DISABLE_BACKGROUND_JOBS. A pass never overlaps the one before. */
export function startCrmLinkLoop(everyMs = 30_000) {
  if (timer || !canCallCrm()) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runLinkOnce(); }
    catch (error) { console.error('[crm] link pass failed:', (error as Error).message); }
    finally { running = false; }
  }, everyMs);
  timer.unref();
}
