import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { badRequest, conflict, notFound } from '../../utils/httpError';

/**
 * Parking a bill. POS-SELL-019, -020, -021. WF-HELD-01.
 *
 * A customer goes back for another saree and someone is waiting behind her. Park her bill, serve
 * the next person, bring hers back exactly as it was.
 *
 * A PARKED BILL IS A DRAFT, NOT A SALE -- and that is why this is not part of Orders. It has no
 * invoice number, no payment, and nothing is kept for anyone. It is a cashier's half-built basket,
 * put down for a minute. A kept order is a real sale a customer is waiting on. Showing them in one
 * list would put a cashier's draft beside a customer's paid-for blouse.
 *
 * HELD ON THE SERVER, for two reasons the browser alone cannot give: it survives a refresh and a
 * browser crash, and it belongs to the SHIFT rather than one cashier -- whoever is free finishes it,
 * at whichever counter.
 */

const MAX_HELD = 50;
const MAX_LINES = 200;

/**
 * What gets parked. Deliberately the SCREEN's basket, not a priced bill: prices are re-read from
 * the database when the sale is finally made, so a parked bill picks up any change made while it
 * sat -- which is correct, and the same rule as every other sale.
 *
 * The once-key is kept with it. If Complete was pressed, timed out, and the cashier parked the
 * basket in a panic, recalling it with the SAME key means a second press replays the sale that may
 * already exist rather than making another one.
 */
export interface HeldPayload {
  lines: { id: string; qty: number; [k: string]: unknown }[];
  customer?: { id: string; name?: string | null; [k: string]: unknown } | null;
  billDiscountPaise?: number;
  onceKey?: string;
}

export interface HeldBillRow {
  id: string;
  label: string;
  counterName: string;
  itemCount: number;
  customerName: string | null;
  parkedBy: string | null;
  createdAt: Date;
}

function summarise(payload: any) {
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  return {
    itemCount: lines.reduce((n: number, l: any) => n + (Number(l?.qty) || 0), 0),
    customerName: payload?.customer?.name ?? null
  };
}

/** POS-SELL-019. Put the basket down. */
export async function park(
  actor: Actor,
  input: { counterId: string; label?: string; payload: HeldPayload }
): Promise<HeldBillRow> {
  const lines = input.payload?.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw badRequest('There is nothing on this bill to park.');
  }
  if (lines.length > MAX_LINES) throw badRequest('That bill is too long to park.');

  const counter = await prisma.counter.findFirst({
    where: { id: input.counterId, clientId: actor.clientId },
    select: { id: true, name: true }
  });
  if (!counter) throw notFound('That till was not found.');

  // A shop with fifty parked bills does not have a parking problem, it has a forgotten-bills
  // problem -- and a list that long is one nobody reads.
  const count = await prisma.heldBill.count({ where: { clientId: actor.clientId } });
  if (count >= MAX_HELD) {
    throw conflict('There are already 50 parked bills. Finish or clear some first.');
  }

  // A label a cashier will recognise across the counter. The customer's name if there is one,
  // otherwise the time -- never an id.
  const { customerName } = summarise(input.payload);
  const label = input.label?.trim()
    || customerName
    || `Parked at ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;

  const held = await prisma.heldBill.create({
    data: {
      clientId: actor.clientId,
      counterId: counter.id,
      label: label.slice(0, 60),
      payload: input.payload as unknown as Prisma.InputJsonValue,
      createdById: actor.id
    },
    select: { id: true, label: true, payload: true, createdAt: true }
  });

  return {
    id: held.id,
    label: held.label,
    counterName: counter.name,
    ...summarise(held.payload),
    parkedBy: actor.name ?? null,
    createdAt: held.createdAt
  };
}

/** WF-HELD-01. Every parked bill in the shop -- the shift's, not one cashier's. Oldest first. */
export async function list(actor: Actor): Promise<HeldBillRow[]> {
  const rows = await prisma.heldBill.findMany({
    where: { clientId: actor.clientId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, label: true, payload: true, createdAt: true, createdById: true, counter: { select: { name: true } } }
  });

  const people = await prisma.user.findMany({
    where: { id: { in: rows.map(r => r.createdById).filter(Boolean) as string[] } },
    select: { id: true, name: true }
  });
  const nameOf = new Map(people.map(p => [p.id, p.name]));

  return rows.map(r => ({
    id: r.id,
    label: r.label,
    counterName: r.counter.name,
    ...summarise(r.payload),
    parkedBy: r.createdById ? nameOf.get(r.createdById) ?? null : null,
    createdAt: r.createdAt
  }));
}

/**
 * POS-SELL-020. Bring it back, exactly as it was, and take it off the list.
 *
 * ONE PERSON GETS IT. Two cashiers tapping the same parked bill at the same moment must not both
 * walk off with it -- that is one customer's saree rung up at two tills. So the bill is taken with
 * a single conditional delete, and whoever deletes zero rows is told somebody else already has it.
 * Reading it first and deleting it second would let both through.
 */
export async function recall(actor: Actor, heldId: string): Promise<HeldPayload> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ payload: any }[]>`
      DELETE FROM held_bills
       WHERE id = ${heldId} AND client_id = ${actor.clientId}
      RETURNING payload`;

    if (rows.length === 0) {
      throw conflict('Someone else has already taken that bill back.', { code: 'ALREADY_RECALLED' });
    }
    return rows[0].payload as HeldPayload;
  });
}

/** Throw a parked bill away. Nothing was sold, so nothing else changes. */
export async function discard(actor: Actor, heldId: string) {
  const result = await prisma.heldBill.deleteMany({ where: { id: heldId, clientId: actor.clientId } });
  if (result.count === 0) throw notFound('That parked bill is already gone.');
  return { ok: true };
}
