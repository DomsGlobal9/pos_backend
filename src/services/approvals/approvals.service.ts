import bcrypt from 'bcryptjs';
import { ApprovalKind, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor, PERMISSIONS, holdsEverything } from '../../types/actor';
import { badRequest, forbidden } from '../../utils/httpError';

/**
 * A manager saying yes, without the cashier logging out. POS-APR-001..006.
 *
 * THE SHAPE OF THIS IS THE FEATURE. A manager walks to the till, types four digits, and walks
 * away. The cashier keeps their session, their basket and the customer standing in front of them.
 *
 * The obvious alternative -- make the manager sign in properly -- fails twice. It logs the cashier
 * out mid-sale, which MASTER.md forbids outright. And in a real shop it means the manager's
 * password is written on a sticky note by the till inside a week, which is worse security than a
 * PIN that only ever authorises one action.
 *
 * A PIN authorises ONE action and proves nothing else. It cannot sign in, cannot open settings,
 * cannot see a report. That is why four digits is enough.
 */

/** Which permission each kind of approval actually requires. */
const REQUIRED_PERMISSION: Record<ApprovalKind, string> = {
  DISCOUNT_OVER_LIMIT: PERMISSIONS.DISCOUNT_OVER_LIMIT,
  PRICE_OVERRIDE: PERMISSIONS.PRICE_OVERRIDE,
  RETURN: PERMISSIONS.REFUND,
  RETURN_OUTSIDE_WINDOW: PERMISSIONS.REFUND_OUTSIDE_WINDOW,
  CASH_OUT: PERMISSIONS.CASH_OUT,
  PAYMENT_VOID: PERMISSIONS.PAYMENT_VOID,
  PAY_LATER: PERMISSIONS.PAY_LATER,
  DUPLICATE_REFERENCE: PERMISSIONS.PAYMENT_VOID,
  WRITE_OFF: PERMISSIONS.WRITE_OFF
};

const HUMAN_KIND: Record<ApprovalKind, string> = {
  DISCOUNT_OVER_LIMIT: 'a discount above the limit',
  PRICE_OVERRIDE: 'a price change',
  RETURN: 'a refund',
  RETURN_OUTSIDE_WINDOW: 'a return after the return window',
  CASH_OUT: 'taking cash out of the drawer',
  PAYMENT_VOID: 'marking a payment as never arrived',
  PAY_LATER: 'selling on credit',
  DUPLICATE_REFERENCE: 'a payment reference already on another bill',
  WRITE_OFF: 'writing off what a customer owes'
};

/**
 * A reason has to be a reason.
 *
 * Four characters, trimmed. It will not stop someone typing "xxxx", but it does stop the two
 * things that actually happen: an empty box, and "na". The point of the field is that an owner
 * reading a month of approvals can see a pattern, and a blank cannot carry one.
 */
export const REASON_MIN = 4;

/**
 * Brute force, and what is honestly done about it.
 *
 * A four-digit PIN is ten thousand guesses. In this setting the realistic attacker is a cashier
 * with the till in front of them and a minute alone, not a script -- so a short lockout after a
 * handful of wrong tries is the right size of defence.
 *
 * IN MEMORY, AND PER PROCESS. A second instance has its own counter, and a restart clears it.
 * Good enough for a shop's own till; a deployment with several instances behind a load balancer
 * needs this in the database or in Redis, and that is a real limitation rather than a detail.
 */
const LOCKOUT_AFTER = 5;
const LOCKOUT_MS = 60_000;
const attempts = new Map<string, { count: number; until: number }>();

function checkLockout(clientId: string) {
  const record = attempts.get(clientId);
  if (record && record.until > Date.now()) {
    const seconds = Math.ceil((record.until - Date.now()) / 1000);
    throw forbidden(
      `Too many wrong PINs. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
      { code: 'PIN_LOCKED_OUT', retryInSeconds: seconds }
    );
  }
}

function noteFailure(clientId: string) {
  const record = attempts.get(clientId) ?? { count: 0, until: 0 };
  record.count += 1;
  if (record.count >= LOCKOUT_AFTER) {
    record.until = Date.now() + LOCKOUT_MS;
    record.count = 0;
  }
  attempts.set(clientId, record);
}

const clearFailures = (clientId: string) => attempts.delete(clientId);

export interface ApprovalRequest {
  kind: ApprovalKind;
  /** Typed by the manager at the till. */
  pin: string;
  /** Typed by whoever is asking. */
  reason: string;
  /** What exactly is being allowed. Frozen onto the approval. */
  detail?: Prisma.InputJsonValue;
}

export interface GrantedApproval {
  id: string;
  kind: ApprovalKind;
  reason: string;
  approvedBy: { id: string; name: string | null };
  requestedBy: { id: string | null; name: string | null };
}

/**
 * Check a PIN, check the permission behind it, and record the approval.
 *
 * Runs inside the caller's transaction when one is given, so an approval and the sale it
 * authorised are written together or not at all. An approval sitting in the table for a sale that
 * never happened is a lie about what a manager agreed to.
 */
export async function grant(
  actor: Actor,
  request: ApprovalRequest,
  tx?: Prisma.TransactionClient
): Promise<GrantedApproval> {
  const db = tx ?? prisma;

  const reason = (request.reason ?? '').trim();
  if (reason.length < REASON_MIN) {
    throw badRequest(
      `Say why ${HUMAN_KIND[request.kind]} is being allowed. A few words is enough.`,
      { code: 'REASON_REQUIRED' }
    );
  }

  const pin = (request.pin ?? '').trim();
  if (!pin) throw badRequest('A manager needs to enter their PIN.', { code: 'PIN_REQUIRED' });

  checkLockout(actor.clientId);

  /*
   * Which manager typed it. Compared against every manager in THIS shop, because a manager should
   * be able to walk to any till and type their own PIN without first being chosen from a list.
   *
   * A shop has a handful of managers, so a handful of bcrypt comparisons. If that ever stops being
   * true, the answer is a manager id alongside the PIN, not a faster hash.
   */
  const managers = await db.user.findMany({
    where: {
      clientId: actor.clientId,
      status: 'ACTIVE',
      deletedAt: null,
      approvalPinHash: { not: null }
    },
    select: {
      id: true, name: true, approvalPinHash: true,
      roles: { select: { role: { select: { name: true, permissions: { select: { permission: { select: { key: true } } } } } } } }
    }
  });

  const matches = [];
  for (const manager of managers) {
    if (await bcrypt.compare(pin, manager.approvalPinHash!)) matches.push(manager);
  }

  if (matches.length === 0) {
    noteFailure(actor.clientId);
    // Deliberately does not say whether the PIN exists but lacks permission -- that would let
    // someone map which PINs are real by trying them.
    throw forbidden('That PIN was not recognised.', { code: 'PIN_NOT_RECOGNISED' });
  }

  if (matches.length > 1) {
    /*
     * Two managers share a PIN. Refusing is the only honest answer: recording the approval against
     * whichever row came back first would put a manager's name against something they never did.
     */
    throw badRequest(
      'Two people have that PIN. Ask the owner to change one of them before approving anything.',
      { code: 'PIN_AMBIGUOUS' }
    );
  }

  const manager = matches[0];
  clearFailures(actor.clientId);

  const roles = manager.roles.map(r => r.role.name);
  const permissions = manager.roles.flatMap(r => r.role.permissions.map(p => p.permission.key));
  const required = REQUIRED_PERMISSION[request.kind];
  const allowed = holdsEverything({ ...actor, roles } as Actor) || permissions.includes(required);

  if (!allowed) {
    throw forbidden(
      `${manager.name ?? 'That person'} is not allowed to approve ${HUMAN_KIND[request.kind]}.`,
      { code: 'NOT_PERMITTED' }
    );
  }

  /*
   * A manager cannot approve their own request.
   *
   * Not because a manager is untrusted -- they could simply do the thing themselves, and that is
   * recorded too. It is so the record means what it says: two names on an approval must be two
   * people, or the field is decoration.
   */
  if (actor.id && manager.id === actor.id) {
    throw badRequest(
      'You can do this yourself — no approval needed. Ask someone else if a second person should agree.',
      { code: 'SELF_APPROVAL' }
    );
  }

  const approval = await db.approval.create({
    data: {
      clientId: actor.clientId,
      kind: request.kind,
      reason,
      detail: request.detail ?? Prisma.JsonNull,
      requestedById: actor.id,
      approvedById: manager.id
    },
    select: { id: true, kind: true, reason: true }
  });

  return {
    id: approval.id,
    kind: approval.kind,
    reason: approval.reason,
    approvedBy: { id: manager.id, name: manager.name },
    requestedBy: { id: actor.id, name: actor.name ?? null }
  };
}

/** Attach an approval to the sale it authorised, once that sale has an id. */
export async function attachToSale(
  tx: Prisma.TransactionClient,
  approvalIds: string[],
  saleId: string
) {
  if (approvalIds.length === 0) return;
  await tx.approval.updateMany({ where: { id: { in: approvalIds } }, data: { saleId } });
}

/** Set or change a manager's PIN. Owner-only; see the route. */
export async function setPin(actor: Actor, userId: string, pin: string) {
  const digits = (pin ?? '').trim();
  if (!/^\d{4,8}$/.test(digits)) {
    throw badRequest('A PIN is 4 to 8 digits.');
  }

  const user = await prisma.user.findFirst({
    where: { id: userId, clientId: actor.clientId, deletedAt: null },
    select: { id: true }
  });
  if (!user) throw badRequest('That person was not found.');

  await prisma.user.update({
    where: { id: userId },
    data: { approvalPinHash: await bcrypt.hash(digits, 10) }
  });
  return { ok: true };
}

/** Test seam for the lockout, which is per-process and otherwise untestable in one run. */
export const __resetLockouts = () => attempts.clear();
