import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { normalisePhone } from '../../utils/phone';
import { systemActor } from '../../types/actor';
import { record } from '../audit';
import { notify } from '../live/live.service';
import { eraseHere } from '../inventory-link/erasures.service';

/**
 * CRM TELLS THE TILL WHO A CUSTOMER IS (19 Nov, owner: CRM owns name, phone, email, birthday, anniversary
 * and merges for a shop with CRM on).
 *
 *   POST /api/v1/webhooks/crm/events   { id, kind, clientId, subjectId, occurredAt, payload }
 *   X-CRM-Event-Id: <id>   X-CRM-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">  (CRM_WEBHOOK_SECRET)
 *
 * Checked over the exact bytes, refused if more than five minutes old, and applied once per event id. Only
 * the till's own copies of customers it already has are touched: CRM's events never add customers here.
 *
 *   customer.changed    the name, and the number when it is free here (a number another customer of this
 *                       till already has is kept as it was, and noted: a merge usually follows)
 *   customer.merged     the dropped copy's bills, returns, parked bills and store credit move to the kept
 *                       one, each recorded, and the dropped copy points at the kept one from then on
 *   customer.unmerged   exactly what that merge moved goes back
 *   customer.removed    { customerId: CRM's id, ids: [{ module, id }], erased, module, id } (CRM, 19 Nov).
 *                       erased: the whole person is gone, and the till's copy is erased as Inventory's
 *                       erasures are. Not erased: only one module's link to them went; when that module is
 *                       the till, its link to CRM is dropped (the customer stays here as they are)
 *
 * The till never waits on any of this: it is a door CRM knocks on, answered in a moment.
 */
const WINDOW_SECONDS = 300;

export type Verdict = 'ok' | 'off' | 'stale' | 'bad';
export function verifyCrm(signature: string | undefined, rawBody: Buffer | undefined, now = Math.floor(Date.now() / 1000)): Verdict {
  const secret = env.CRM_WEBHOOK_SECRET;
  if (!secret) return 'off';
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(signature ?? '').trim());
  if (!m || !rawBody) return 'bad';
  const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.`).update(rawBody).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))) return 'bad';
  if (Math.abs(now - Number(m[1])) > WINDOW_SECONDS) return 'stale';
  return 'ok';
}

type Tx = Prisma.TransactionClient;
type View = { id?: string; name?: string | null; phone?: string | null; ids?: { module: string; id: string }[] } | null | undefined;
/** The names CRM files this till's own ids under (its service name now; 'pos' for the older feed). */
const mine = () => new Set([env.POS_SERVICE_ISS, 'pos']);

/**
 * CRM's record of who someone is, onto the till's copy. The name, when CRM has one; the number, when no
 * other customer here has it. Returns what changed, for the log.
 */
export async function applyCrmView(tx: Tx, clientId: string, customerId: string, view: View): Promise<string[]> {
  if (!view) return [];
  const c = await tx.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: { id: true, name: true, phone: true } });
  if (!c) return [];
  const data: Prisma.CustomerUpdateInput = {};
  const changed: string[] = [];
  const name = typeof view.name === 'string' ? view.name.trim().slice(0, 120) : '';
  if (name && name !== c.name) { data.name = name; changed.push('name'); }
  if (typeof view.phone === 'string' && view.phone) {
    let phone: string | null = null;
    try { phone = normalisePhone(view.phone).e164; } catch { phone = null; }
    if (phone && phone !== c.phone) {
      const taken = await tx.customer.findFirst({ where: { clientId, phone, id: { not: c.id } }, select: { id: true } });
      if (taken) changed.push('phone-kept:taken-here');
      else { data.phone = phone; changed.push('phone'); }
    }
  }
  if (Object.keys(data).length) await tx.customer.update({ where: { id: c.id }, data });
  return changed;
}

/** The till's customers linked to one CRM person (one, normally; two only until a merge reaches here). */
async function copiesOf(tx: Tx, clientId: string, crmId: string) {
  const links = await tx.crmCustomerLink.findMany({ where: { clientId, crmCustomerId: crmId }, select: { customerId: true } });
  return tx.customer.findMany({
    where: { id: { in: links.map(l => l.customerId) }, clientId, deletedAt: null },
    select: { id: true, mergedIntoId: true, storeCreditPaise: true, loyaltyPoints: true }, orderBy: { createdAt: 'asc' }
  });
}

/** The till's shops behind CRM's id for a shop (Inventory's id for it). */
async function tillShopsOf(crmClientId: string) {
  const links = await prisma.inventoryLink.findMany({ where: { platformClientId: crmClientId, connected: true }, select: { clientId: true } });
  return links.map(l => l.clientId);
}

type Moved = { sales: string[]; returns: string[]; heldBills: string[]; creditPaise: number; points: number };

async function merge(tx: Tx, clientId: string, eventId: string, fromCrm: string, intoCrm: string): Promise<string> {
  const dropped = (await copiesOf(tx, clientId, fromCrm)).filter(c => !c.mergedIntoId);
  if (!dropped.length) return 'no copy here';
  const kept = (await copiesOf(tx, clientId, intoCrm)).find(c => !c.mergedIntoId);
  const outcomes: string[] = [];
  for (const d of dropped) {
    if (!kept) {
      // The till has only the dropped one: it simply becomes CRM's kept person.
      await tx.crmCustomerLink.update({ where: { customerId: d.id }, data: { crmCustomerId: intoCrm } });
      await tx.crmCustomerMerge.create({ data: { clientId, eventId, fromCrmId: fromCrm, intoCrmId: intoCrm, droppedCustomerId: d.id, keptCustomerId: null, moved: { relinked: true } } });
      outcomes.push('relinked');
      continue;
    }
    if (kept.id === d.id) continue;
    const sales = (await tx.sale.findMany({ where: { clientId, customerId: d.id }, select: { id: true } })).map(r => r.id);
    const returns = (await tx.return.findMany({ where: { clientId, customerId: d.id }, select: { id: true } })).map(r => r.id);
    const held = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM held_bills WHERE client_id = ${clientId} AND payload->'customer'->>'id' = ${d.id}`;
    if (sales.length) await tx.sale.updateMany({ where: { id: { in: sales } }, data: { customerId: kept.id } });
    if (returns.length) await tx.return.updateMany({ where: { id: { in: returns } }, data: { customerId: kept.id } });
    for (const h of held) {
      await tx.$executeRaw`UPDATE held_bills SET payload = jsonb_set(payload, '{customer,id}', to_jsonb(${kept.id}::text)) WHERE id = ${h.id}`;
    }
    // Money the shop owes them, and their points: moved in the ledger, both sides, never lost or doubled.
    const credit = d.storeCreditPaise > 0 ? d.storeCreditPaise : 0;
    const points = d.loyaltyPoints > 0 ? d.loyaltyPoints : 0;
    if (credit || points) {
      await tx.customer.update({ where: { id: d.id }, data: { storeCreditPaise: { decrement: credit }, loyaltyPoints: { decrement: points } } });
      const k = await tx.customer.update({ where: { id: kept.id }, data: { storeCreditPaise: { increment: credit }, loyaltyPoints: { increment: points } }, select: { storeCreditPaise: true } });
      if (credit) {
        await tx.storeCreditEntry.create({ data: { clientId, customerId: d.id, amountPaise: -credit, balanceAfterPaise: 0 } });
        await tx.storeCreditEntry.create({ data: { clientId, customerId: kept.id, amountPaise: credit, balanceAfterPaise: k.storeCreditPaise } });
      }
    }
    await tx.customer.update({ where: { id: d.id }, data: { mergedIntoId: kept.id } });
    const moved: Moved = { sales, returns, heldBills: held.map(h => h.id), creditPaise: credit, points };
    await tx.crmCustomerMerge.create({ data: { clientId, eventId, fromCrmId: fromCrm, intoCrmId: intoCrm, droppedCustomerId: d.id, keptCustomerId: kept.id, moved: moved as any } });
    await record(systemActor(clientId), { action: 'customer.merged', subject: kept.id, detail: { by: 'ScaleEzy CRM', droppedCustomerId: d.id, sales: sales.length, returns: returns.length, creditPaise: credit, points } as Prisma.InputJsonValue });
    outcomes.push(`merged ${sales.length} bills, ${returns.length} returns, ${held.length} parked`);
  }
  return outcomes.join('; ') || 'nothing to move';
}

async function unmerge(tx: Tx, clientId: string, restoredCrm: string, fromCrm: string): Promise<string> {
  const merges = await tx.crmCustomerMerge.findMany({ where: { clientId, fromCrmId: restoredCrm, intoCrmId: fromCrm, undoneAt: null }, orderBy: { createdAt: 'desc' } });
  if (!merges.length) return 'no merge here to undo';
  for (const m of merges) {
    const moved = m.moved as any;
    if (m.droppedCustomerId && moved?.relinked) {
      await tx.crmCustomerLink.update({ where: { customerId: m.droppedCustomerId }, data: { crmCustomerId: restoredCrm } }).catch(() => {});
    } else if (m.droppedCustomerId && m.keptCustomerId) {
      const d = m.droppedCustomerId, k = m.keptCustomerId;
      // Only what the merge moved and is still on the kept customer goes back.
      if (moved.sales?.length) await tx.sale.updateMany({ where: { id: { in: moved.sales }, customerId: k }, data: { customerId: d } });
      if (moved.returns?.length) await tx.return.updateMany({ where: { id: { in: moved.returns }, customerId: k }, data: { customerId: d } });
      for (const h of moved.heldBills ?? []) {
        await tx.$executeRaw`UPDATE held_bills SET payload = jsonb_set(payload, '{customer,id}', to_jsonb(${d}::text)) WHERE id = ${h} AND payload->'customer'->>'id' = ${k}`;
      }
      // The credit and points go back as far as the kept customer still holds them (some may be spent since).
      const keptNow = await tx.customer.findUniqueOrThrow({ where: { id: k }, select: { storeCreditPaise: true, loyaltyPoints: true } });
      const credit = Math.min(moved.creditPaise ?? 0, keptNow.storeCreditPaise);
      const points = Math.min(moved.points ?? 0, keptNow.loyaltyPoints);
      if (credit || points) {
        const kk = await tx.customer.update({ where: { id: k }, data: { storeCreditPaise: { decrement: credit }, loyaltyPoints: { decrement: points } }, select: { storeCreditPaise: true } });
        const dd = await tx.customer.update({ where: { id: d }, data: { storeCreditPaise: { increment: credit }, loyaltyPoints: { increment: points } }, select: { storeCreditPaise: true } });
        if (credit) {
          await tx.storeCreditEntry.create({ data: { clientId, customerId: k, amountPaise: -credit, balanceAfterPaise: kk.storeCreditPaise } });
          await tx.storeCreditEntry.create({ data: { clientId, customerId: d, amountPaise: credit, balanceAfterPaise: dd.storeCreditPaise } });
        }
      }
      await tx.customer.update({ where: { id: d }, data: { mergedIntoId: null } });
      // Their own CRM person again (a later customer.changed may have pointed them at the kept one).
      await tx.crmCustomerLink.updateMany({ where: { customerId: d }, data: { crmCustomerId: restoredCrm } });
      await record(systemActor(clientId), { action: 'customer.unmerged', subject: d, detail: { by: 'ScaleEzy CRM', fromCustomerId: k, sales: moved.sales?.length ?? 0, creditPaise: credit, points } as Prisma.InputJsonValue });
    }
    await tx.crmCustomerMerge.update({ where: { id: m.id }, data: { undoneAt: new Date() } });
  }
  return `undid ${merges.length}`;
}

export type CrmEvent = { id: string; kind: string; clientId: string; subjectId?: string; occurredAt?: string; payload?: any };

/** Apply one event to every till shop behind CRM's shop. Returns the outcome, recorded with the event id. */
export async function applyCrmEvent(e: CrmEvent): Promise<{ applied: boolean; outcome: string }> {
  if (await prisma.crmInboundEvent.findUnique({ where: { id: e.id }, select: { id: true } })) return { applied: false, outcome: 'already applied' };
  const shops = await tillShopsOf(e.clientId);
  const outcomes: string[] = [];
  for (const clientId of shops) {
    const p = e.payload ?? {};
    let outcome = 'ignored';
    if (e.kind === 'customer.changed' && p.customer?.id) {
      outcome = await prisma.$transaction(async tx => {
        // A customer of this till CRM has just linked by our own id: remember the link first.
        for (const ref of (p.customer.ids ?? []) as { module: string; id: string }[]) {
          if (!mine().has(ref.module)) continue;
          const own = await tx.customer.findFirst({ where: { id: ref.id, clientId, deletedAt: null }, select: { id: true } });
          if (own) await tx.crmCustomerLink.upsert({ where: { customerId: own.id }, update: { crmCustomerId: p.customer.id, linkedAt: new Date(), lastProblem: null }, create: { customerId: own.id, clientId, crmCustomerId: p.customer.id, linkedAt: new Date() } });
        }
        const copies = await copiesOf(tx, clientId, p.customer.id);
        const done: string[] = [];
        for (const c of copies.filter(c => !c.mergedIntoId)) done.push(...(await applyCrmView(tx, clientId, c.id, p.customer)));
        return copies.length ? `changed: ${done.join(', ') || 'nothing new'}` : 'not a customer here';
      });
    } else if (e.kind === 'customer.merged' && p.from && p.into) {
      outcome = await prisma.$transaction(tx => merge(tx, clientId, e.id, String(p.from), String(p.into)));
    } else if (e.kind === 'customer.unmerged' && p.restored && p.from) {
      outcome = await prisma.$transaction(tx => unmerge(tx, clientId, String(p.restored), String(p.from)));
    } else if (e.kind === 'customer.removed') {
      // The till's copies: by CRM's id for the person, or by the till's own id among theirs.
      const ownIds = ((p.ids ?? []) as { module: string; id: string }[]).filter(r => mine().has(String(r.module))).map(r => String(r.id));
      if (mine().has(String(p.module)) && p.id) ownIds.push(String(p.id));
      const byCrm = p.customerId ? (await prisma.crmCustomerLink.findMany({ where: { clientId, crmCustomerId: String(p.customerId) }, select: { customerId: true } })).map(l => l.customerId) : [];
      const copies = await prisma.customer.findMany({ where: { clientId, deletedAt: null, id: { in: [...new Set([...ownIds, ...byCrm])] } }, select: { id: true, phone: true } });
      if (!copies.length) outcome = 'not ours to match';
      else if (p.erased === true) {
        const done: string[] = [];
        for (const c of copies) done.push(await eraseHere(clientId, { id: e.id, phone: c.phone, erasedAt: e.occurredAt ?? new Date().toISOString() }));
        outcome = `removed: ${done.join(', ')}`;
      } else if (mine().has(String(p.module))) {
        // Only the till's link to CRM went: the customer stays here, and is linked again on its next change.
        await prisma.crmCustomerLink.deleteMany({ where: { clientId, customerId: { in: copies.map(c => c.id) } } });
        outcome = 'link to CRM dropped';
      } else outcome = 'not ours to match';
    }
    outcomes.push(`${clientId}: ${outcome}`);
    if (outcome !== 'ignored' && !/^not /.test(outcome)) notify(clientId, 'customers', 'sales');
  }
  const outcome = outcomes.join(' | ') || 'no till for this shop';
  await prisma.crmInboundEvent.create({ data: { id: e.id, clientId: e.clientId, kind: e.kind, outcome: outcome.slice(0, 500) } }).catch(() => {});
  return { applied: true, outcome };
}
