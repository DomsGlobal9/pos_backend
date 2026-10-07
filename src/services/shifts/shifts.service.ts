import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { rupees } from '../money';
import { grant } from '../approvals';
import { record, AuditEntry } from '../audit';

/**
 * The shift: one drawer, from the moment someone counts the float in to the moment someone counts
 * the takings out. POS-SHIFT-001..009.
 *
 * THE FEATURE THAT MAKES AN OWNER TRUST THE SOFTWARE. At 9 pm the owner asks one question -- is
 * the cash right? -- and this is the only place that can answer it.
 *
 * Four rules, each for a reason:
 *
 *   1. EXPECTED CASH IS DERIVED, NEVER STORED WHILE OPEN. Opening float, plus cash payments, minus
 *      cash refunds, plus cash in, minus cash out -- added up from the rows every time it is asked.
 *      A running total is a second copy of the truth, and second copies drift.
 *
 *   2. CASH BELONGS TO THE DRAWER IT WENT INTO. Each payment, refund and movement row carries the
 *      shift that was open at its counter. A kept order's balance collected on Saturday counts in
 *      Saturday's drawer, not in the one the order was taken at.
 *
 *   3. THE COUNT IS BLIND AND IT STICKS. The person closing types what they counted before the till
 *      says what it expected. If the two differ, they may count again -- real shops do -- or say
 *      what happened; every mismatched count is in the audit trail, so recounting until it matches
 *      is visible. The difference is recorded as it is. Never silently corrected.
 *
 *   4. SELLING IS NEVER BLOCKED BY A MISSING SHIFT. A customer at the counter is served. Cash taken
 *      with no shift open is not attached to any drawer, and the day close reports it on its own
 *      line so it cannot hide.
 */

type Db = Prisma.TransactionClient | typeof prisma;


/*
 * A drawer holds less than Rs 1 crore. More is a typing slip -- found live 7 Oct: the float box
 * offered 22599, the cashier typed 5000 after it, and 225995000 rupees overflowed the 32-bit money
 * column into a server error. Now it is one sentence.
 */
const DRAWER_MAX_PAISE = 1_000_000_000;
const TOO_MUCH = 'That is more than Rs 1 crore -- check the amount you typed.';

export const NOTE_MIN = 3;

// ------------------------------------------------------------------------------------------------
// Which drawer a piece of cash belongs to
// ------------------------------------------------------------------------------------------------

/**
 * The open shift that a payment, refund or movement made now belongs to. Called INSIDE the
 * caller's transaction.
 *
 * FOR SHARE on the shift row: closing a shift takes FOR UPDATE on the same row, so a sale in flight
 * and a close cannot pass each other. Either the sale commits first and the close counts its cash,
 * or the close commits first and the sale finds no open shift -- never a sale attached to a drawer
 * that was already counted.
 *
 * By counter when the till says which one it is. Otherwise the person's own open shift, if they
 * have exactly one -- a collection made from the Orders screen does not always know its counter.
 * Null when nothing fits: the cash is then reported as "no shift open", not guessed into a drawer.
 */
export async function shiftFor(
  tx: Prisma.TransactionClient,
  actor: Actor,
  counterId?: string | null
): Promise<string | null> {
  if (counterId) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM shifts
       WHERE client_id = ${actor.clientId} AND counter_id = ${counterId} AND closed_at IS NULL
       FOR SHARE`;
    return rows[0]?.id ?? null;
  }
  if (actor.id) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM shifts
       WHERE client_id = ${actor.clientId} AND cashier_id = ${actor.id} AND closed_at IS NULL
       FOR SHARE`;
    return rows.length === 1 ? rows[0].id : null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// The figures
// ------------------------------------------------------------------------------------------------

export interface CashFigures {
  openingPaise: number;
  cashSalesPaise: number;
  cashRefundsPaise: number;
  cashInPaise: number;
  cashOutPaise: number;
  /** What should be in the drawer. POS-SHIFT-005. */
  expectedPaise: number;
}

/** Added up from the rows, every time. Rule 1. */
export async function cashFigures(db: Db, shiftId: string, openingPaise: number): Promise<CashFigures> {
  const [sales, refunds, moves] = await Promise.all([
    db.payment.aggregate({
      where: { shiftId, method: 'CASH', status: 'COLLECTED' },
      _sum: { amountPaise: true }
    }),
    db.returnRefund.aggregate({
      where: { shiftId, method: 'CASH' },
      _sum: { amountPaise: true }
    }),
    db.cashMovement.groupBy({
      by: ['direction'],
      where: { shiftId },
      _sum: { amountPaise: true }
    })
  ]);
  const cashSalesPaise = sales._sum.amountPaise ?? 0;
  const cashRefundsPaise = refunds._sum.amountPaise ?? 0;
  const cashInPaise = moves.find(m => m.direction === 'IN')?._sum.amountPaise ?? 0;
  const cashOutPaise = moves.find(m => m.direction === 'OUT')?._sum.amountPaise ?? 0;
  return {
    openingPaise,
    cashSalesPaise,
    cashRefundsPaise,
    cashInPaise,
    cashOutPaise,
    expectedPaise: openingPaise + cashSalesPaise - cashRefundsPaise + cashInPaise - cashOutPaise
  };
}

const startOfToday = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

/** POS-SHIFT-009. Open since before today began -- somebody went home without closing it. */
export const openSinceYesterday = (openedAt: Date, closedAt: Date | null, now = new Date()) =>
  !closedAt && openedAt.getTime() < startOfToday(now).getTime();

// ------------------------------------------------------------------------------------------------
// WF-SHIFT-01: the counter's drawer, now
// ------------------------------------------------------------------------------------------------

const SHIFT_SELECT = {
  id: true, counterId: true, openedAt: true, openingCashPaise: true,
  closedAt: true, expectedCashPaise: true, countedCashPaise: true, differencePaise: true,
  closingNote: true, closedById: true,
  counter: { select: { id: true, name: true } },
  cashier: { select: { id: true, name: true } }
} as const;

/**
 * The counter's open shift with its figures, the last few closed ones, and what the next float
 * should probably be (what the last shift left in the drawer).
 *
 * The expected figure goes only to people who may close the day. A cashier sees their movements
 * but not the till's answer, so the count at the end is a count and not a copy.
 */
export async function current(actor: Actor, counterId: string) {
  const counter = await prisma.counter.findFirst({
    where: { id: counterId, clientId: actor.clientId },
    select: { id: true, name: true, active: true }
  });
  if (!counter) throw notFound('That counter was not found.');

  const [open, recent] = await Promise.all([
    prisma.shift.findFirst({ where: { clientId: actor.clientId, counterId, closedAt: null }, select: SHIFT_SELECT }),
    prisma.shift.findMany({
      where: { clientId: actor.clientId, counterId, closedAt: { not: null } },
      orderBy: { closedAt: 'desc' },
      take: 5,
      select: SHIFT_SELECT
    })
  ]);

  const seesExpected = may(actor, PERMISSIONS.CLOSE_DAY);
  let figures: CashFigures | null = null;
  let movements: { id: string; direction: 'IN' | 'OUT'; amountPaise: number; reason: string; createdAt: Date; by: string | null }[] = [];

  if (open) {
    figures = await cashFigures(prisma, open.id, open.openingCashPaise);
    const rows = await prisma.cashMovement.findMany({
      where: { shiftId: open.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, direction: true, amountPaise: true, reason: true, createdAt: true, byId: true }
    });
    const names = await namesOf(rows.map(r => r.byId));
    movements = rows.map(r => ({
      id: r.id, direction: r.direction, amountPaise: r.amountPaise, reason: r.reason,
      createdAt: r.createdAt, by: r.byId ? names.get(r.byId) ?? null : null
    }));
  }

  const closerNames = await namesOf(recent.map(r => r.closedById));

  return {
    counter,
    open: open && {
      id: open.id,
      openedAt: open.openedAt,
      openedBy: open.cashier?.name ?? null,
      openedById: open.cashier?.id ?? null,
      openingCashPaise: open.openingCashPaise,
      openSinceYesterday: openSinceYesterday(open.openedAt, open.closedAt),
      mayClose: open.cashier?.id === actor.id || may(actor, PERMISSIONS.CLOSE_DAY),
      figures: seesExpected ? figures : null,
      movements
    },
    /** What the last shift on this counter was counted at -- usually tomorrow's float. */
    suggestedOpeningPaise: recent[0]?.countedCashPaise ?? null,
    recent: recent.map(r => ({
      id: r.id,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      openedBy: r.cashier?.name ?? null,
      closedBy: r.closedById ? closerNames.get(r.closedById) ?? null : null,
      countedCashPaise: r.countedCashPaise,
      // The variance of a CLOSED shift is not a secret -- it is the thing everyone should see.
      differencePaise: r.differencePaise,
      closingNote: r.closingNote
    }))
  };
}

async function namesOf(ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return new Map<string, string | null>();
  const users = await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(users.map(u => [u.id, u.name]));
}

// ------------------------------------------------------------------------------------------------
// Opening
// ------------------------------------------------------------------------------------------------

/** POS-SHIFT-001. Count the float in. */
export async function open(actor: Actor, input: { counterId: string; openingCashPaise: number }) {
  if (!Number.isInteger(input.openingCashPaise) || input.openingCashPaise < 0) {
    throw badRequest('Enter the cash in the drawer. Nothing at all is fine -- type 0.');
  }
  if (input.openingCashPaise > DRAWER_MAX_PAISE) {
    throw badRequest(TOO_MUCH, { code: 'AMOUNT_TOO_LARGE' });
  }

  const counter = await prisma.counter.findFirst({
    where: { id: input.counterId, clientId: actor.clientId },
    select: { id: true, name: true, active: true }
  });
  if (!counter) throw notFound('That counter was not found.');
  if (!counter.active) throw conflict(`${counter.name} is switched off. Choose another counter.`);

  const already = await prisma.shift.findFirst({
    where: { clientId: actor.clientId, counterId: counter.id, closedAt: null },
    select: SHIFT_SELECT
  });
  if (already) throw alreadyOpen(counter.name, already);

  try {
    const shift = await prisma.shift.create({
      data: {
        clientId: actor.clientId,
        counterId: counter.id,
        cashierId: actor.kind === 'USER' ? actor.id : null,
        openingCashPaise: input.openingCashPaise
      },
      select: { id: true }
    });
    await record(actor, {
      action: 'shift.opened',
      subject: counter.name,
      detail: { shiftId: shift.id, openingCashPaise: input.openingCashPaise }
    });
    return current(actor, counter.id);
  } catch (error: any) {
    // Two people pressed Open on the same counter at once. The database let one through; tell the
    // other who has it, rather than showing a constraint error.
    if (error?.code === 'P2002' || /shifts_one_open_per_counter/.test(error?.message ?? '')) {
      const winner = await prisma.shift.findFirst({
        where: { clientId: actor.clientId, counterId: counter.id, closedAt: null },
        select: SHIFT_SELECT
      });
      if (winner) throw alreadyOpen(counter.name, winner);
    }
    throw error;
  }
}

function alreadyOpen(counterName: string, shift: { id: string; openedAt: Date; cashier: { name: string | null } | null }) {
  const at = shift.openedAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return conflict(
    `${counterName} already has a shift open${shift.cashier?.name ? `, by ${shift.cashier.name}` : ''} since ${at}.`,
    { code: 'SHIFT_ALREADY_OPEN', shiftId: shift.id }
  );
}

// ------------------------------------------------------------------------------------------------
// Cash in and out. WF-CASH-01.
// ------------------------------------------------------------------------------------------------

export interface MoveInput {
  counterId: string;
  direction: 'IN' | 'OUT';
  amountPaise: number;
  reason: string;
  onceKey: string;
  approval?: { pin: string; reason: string };
}

/**
 * POS-SHIFT-003, -004. Amount, reason, person -- all three, always.
 *
 * Cash OUT by someone without the right needs a manager's PIN, in place, like a big discount.
 * And never more than the drawer should hold: taking out cash that is not there is a typo or a
 * story, and either way the till should not record it as fact.
 */
export async function move(actor: Actor, input: MoveInput) {
  const reason = (input.reason ?? '').trim();
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw badRequest('Enter an amount.');
  if (input.amountPaise > DRAWER_MAX_PAISE) throw badRequest(TOO_MUCH, { code: 'AMOUNT_TOO_LARGE' });
  if (reason.length < NOTE_MIN) {
    throw badRequest(`Say what the cash was ${input.direction === 'IN' ? 'for' : 'taken for'} -- "courier", "change float".`);
  }

  const existing = await prisma.cashMovement.findUnique({ where: { onceKey: input.onceKey }, select: { id: true, clientId: true } });
  if (existing) {
    if (existing.clientId !== actor.clientId) throw conflict('That key is already in use. Try again.');
    return { replayed: true, ...(await current(actor, input.counterId)) };
  }

  const pendingAudit: AuditEntry[] = [];

  try {
    await prisma.$transaction(async (tx) => {
      // FOR UPDATE: two cash-outs at once must each see the other's effect on the drawer, and a
      // close must not count the drawer halfway through one.
      const rows = await tx.$queryRaw<{ id: string; opening_cash_paise: number }[]>`
        SELECT id, opening_cash_paise FROM shifts
         WHERE client_id = ${actor.clientId} AND counter_id = ${input.counterId} AND closed_at IS NULL
         FOR UPDATE`;
      const shift = rows[0];
      if (!shift) {
        throw conflict('No shift is open on this counter. Open one first -- cash in and out belongs to a drawer.', { code: 'NO_SHIFT' });
      }

      let approvedById: string | null = null;
      if (input.direction === 'OUT') {
        const figures = await cashFigures(tx, shift.id, Number(shift.opening_cash_paise));
        if (input.amountPaise > figures.expectedPaise) {
          throw conflict(
            figures.expectedPaise <= 0
              ? 'The drawer should be empty, so no cash can come out of it.'
              : `Only ${rupees(figures.expectedPaise)} should be in the drawer. Count it -- if there is more, record the extra as cash in first.`,
            { code: 'MORE_THAN_DRAWER' }
          );
        }

        if (!may(actor, PERMISSIONS.CASH_OUT)) {
          const detail = { amountPaise: input.amountPaise, forWhat: reason };
          if (!input.approval) {
            throw forbidden('A manager needs to approve cash going out of the drawer.', {
              code: 'APPROVAL_REQUIRED', kind: 'CASH_OUT', ...detail
            });
          }
          const granted = await grant(actor, { kind: 'CASH_OUT', pin: input.approval.pin, reason: input.approval.reason, detail }, tx);
          approvedById = granted.approvedBy.id;
          pendingAudit.push({
            action: 'approval.granted',
            detail: { kind: 'CASH_OUT', reason: granted.reason, approvedBy: granted.approvedBy.name, approvedById, ...detail }
          });
        }
      }

      await tx.cashMovement.create({
        data: {
          clientId: actor.clientId,
          shiftId: shift.id,
          direction: input.direction,
          amountPaise: input.amountPaise,
          reason,
          byId: actor.kind === 'USER' ? actor.id : null,
          approvedById,
          onceKey: input.onceKey
        }
      });
      pendingAudit.push({
        action: input.direction === 'IN' ? 'cash.in' : 'cash.out',
        detail: { amountPaise: input.amountPaise, reason, shiftId: shift.id }
      });
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const winner = await prisma.cashMovement.findUnique({ where: { onceKey: input.onceKey }, select: { id: true } });
      if (winner) return { replayed: true, ...(await current(actor, input.counterId)) };
    }
    throw error;
  }

  for (const entry of pendingAudit) await record(actor, entry);
  return { replayed: false, ...(await current(actor, input.counterId)) };
}

// ------------------------------------------------------------------------------------------------
// Closing
// ------------------------------------------------------------------------------------------------

/**
 * POS-SHIFT-006, -007, -008. Rule 3: blind, and it sticks.
 *
 * A count that does not match, with no note, is refused WITHOUT saying by how much -- "count
 * again, or say what happened". Saying the figure would turn the count into a copy. The attempt is
 * written to the audit trail with both numbers, so an owner can see a drawer that took five counts.
 *
 * Once closed, a shift is never edited or reopened. A mistake in the count is a note on the next
 * shift or a cash movement, not a change to this one.
 */
export async function close(actor: Actor, shiftId: string, input: { countedCashPaise: number; note?: string }) {
  if (!Number.isInteger(input.countedCashPaise) || input.countedCashPaise < 0) {
    throw badRequest('Enter what you counted in the drawer.');
  }
  if (input.countedCashPaise > DRAWER_MAX_PAISE) {
    throw badRequest(TOO_MUCH, { code: 'AMOUNT_TOO_LARGE' });
  }
  const note = (input.note ?? '').trim();

  let mismatch: { expectedPaise: number; countedPaise: number } | null = null;
  let result: { expectedPaise: number; differencePaise: number; counterName: string } | null = null;

  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; counter_id: string; cashier_id: string | null; opening_cash_paise: number; closed_at: Date | null }[]>`
      SELECT id, counter_id, cashier_id, opening_cash_paise, closed_at FROM shifts
       WHERE id = ${shiftId} AND client_id = ${actor.clientId}
       FOR UPDATE`;
    const shift = rows[0];
    if (!shift) throw notFound('That shift was not found.');
    if (shift.closed_at) throw conflict('That shift is already closed. A closed shift is never changed.', { code: 'ALREADY_CLOSED' });

    // A cashier closes their own drawer. Anyone else's needs the right to close the day. MASTER §8.
    if (shift.cashier_id !== actor.id && !may(actor, PERMISSIONS.CLOSE_DAY)) {
      const owner = shift.cashier_id
        ? await tx.user.findUnique({ where: { id: shift.cashier_id }, select: { name: true } })
        : null;
      throw forbidden(`Only ${owner?.name ?? 'the person who opened it'} or a manager can close this shift.`, { code: 'NOT_YOUR_SHIFT' });
    }

    const figures = await cashFigures(tx, shift.id, Number(shift.opening_cash_paise));
    const differencePaise = input.countedCashPaise - figures.expectedPaise;

    if (differencePaise !== 0 && note.length < NOTE_MIN) {
      mismatch = { expectedPaise: figures.expectedPaise, countedPaise: input.countedCashPaise };
      return;
    }

    await tx.shift.update({
      where: { id: shift.id },
      data: {
        closedAt: new Date(),
        expectedCashPaise: figures.expectedPaise,
        countedCashPaise: input.countedCashPaise,
        differencePaise,
        closingNote: note || null,
        closedById: actor.kind === 'USER' ? actor.id : null
      }
    });
    const counter = await tx.counter.findUnique({ where: { id: shift.counter_id }, select: { name: true } });
    result = { expectedPaise: figures.expectedPaise, differencePaise, counterName: counter?.name ?? '' };
  });

  if (mismatch) {
    const m = mismatch as { expectedPaise: number; countedPaise: number };
    // Recorded because it happened, even though nothing was closed.
    await record(actor, { action: 'shift.count_mismatch', detail: { shiftId, ...m } });
    throw conflict(
      "That count doesn't match what the till expects. Count again -- or, if you're sure, add a note saying what happened.",
      { code: 'COUNT_MISMATCH' }
    );
  }

  const r = result as unknown as { expectedPaise: number; differencePaise: number; counterName: string };
  await record(actor, {
    action: 'shift.closed',
    subject: r.counterName,
    detail: { shiftId, expectedPaise: r.expectedPaise, countedPaise: input.countedCashPaise, differencePaise: r.differencePaise, note: note || null }
  });

  return {
    shiftId,
    expectedPaise: r.expectedPaise,
    countedCashPaise: input.countedCashPaise,
    differencePaise: r.differencePaise
  };
}

/** Every shift open anywhere in the shop. Home and the day close both need it. */
export async function openShifts(clientId: string) {
  const rows = await prisma.shift.findMany({
    where: { clientId, closedAt: null },
    orderBy: { openedAt: 'asc' },
    select: SHIFT_SELECT
  });
  return rows.map(r => ({
    id: r.id,
    counterId: r.counterId,
    counterName: r.counter.name,
    openedBy: r.cashier?.name ?? null,
    openedAt: r.openedAt,
    openSinceYesterday: openSinceYesterday(r.openedAt, r.closedAt)
  }));
}
