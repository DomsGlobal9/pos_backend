import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';

/**
 * Who did what. POS-CORE-010.
 *
 * Everything sensitive at a till is recorded with who and when: a discount over the limit, a price
 * override, a refund, a day close, a cancelled sale.
 *
 * WHAT THIS IS FOR is worth being precise about, because it changes what gets written. An owner
 * reading it back is not asking "did someone override a price" -- they can see that from the bill.
 * They are asking "who keeps doing this, and what reason do they keep giving". So every entry
 * carries the actor's NAME as it was at the time, not just an id: a staff member who left six
 * months ago still has to be nameable.
 *
 * It is append-only by convention -- nothing in this service updates or deletes -- and nothing
 * here may fail a sale. An audit write that can roll back a transaction turns a logging problem
 * into a lost sale, so `record` is called AFTER the work it describes and swallows its own errors.
 */

export type AuditAction =
  | 'sale.completed'
  | 'sale.discount_over_limit'
  | 'sale.price_override'
  | 'payment.unconfirmed'
  | 'payment.resolved'
  | 'bill.reprinted'
  | 'approval.granted'
  | 'approval.refused'
  | 'order.handed_over_with_due'
  | 'return.created'
  | 'exchange.created'
  | 'store_credit.spent'
  | 'shift.opened'
  | 'shift.closed'
  | 'shift.count_mismatch'
  | 'cash.in'
  | 'cash.out'
  | 'day.closed'
  | 'inventory.connected'
  | 'inventory.disconnected'
  | 'inventory.retried'
  | 'inventory.catalogue_synced';

export interface AuditEntry {
  action: AuditAction;
  /** By PUBLIC identity where there is one -- an invoice number, not a uuid. */
  subject?: string | null;
  detail?: Prisma.InputJsonValue;
}

/**
 * Write one entry.
 *
 * Never throws. A shop with a customer at the counter needs the sale far more than we need the
 * log line, so a failure here is logged to the console and nothing else. That is a deliberate
 * trade and not an oversight: the alternative is a logging table filling its disk and taking the
 * till down with it.
 */
export async function record(actor: Actor, entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        clientId: actor.clientId,
        actorId: actor.id,
        // Copied, not looked up later. Somebody who leaves the shop must still be nameable.
        actorName: actor.name ?? null,
        action: entry.action,
        subject: entry.subject ?? null,
        detail: entry.detail ?? Prisma.JsonNull
      }
    });
  } catch (error: any) {
    console.error(`[audit] could not record ${entry.action}:`, error?.message);
  }
}

export interface AuditRow {
  id: string;
  action: string;
  actorName: string | null;
  subject: string | null;
  detail: unknown;
  createdAt: Date;
}

/** What happened, newest first. For the owner, under More -- never on a cashier's screen. */
export async function recent(actor: Actor, limit = 100): Promise<AuditRow[]> {
  const rows = await prisma.auditLog.findMany({
    where: { clientId: actor.clientId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
    select: { id: true, action: true, actorName: true, subject: true, detail: true, createdAt: true }
  });
  return rows as AuditRow[];
}
