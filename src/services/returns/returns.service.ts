import { Prisma, RefundMethod, PaymentMethod } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { maskPhone } from '../../utils/phone';
import { rupees } from '../money';
import { nextNumber } from '../invoice-series';
import { owedPaise, pretty } from '../payments';
import { grant } from '../approvals';
import { record, AuditEntry } from '../audit';
import { addCredit } from '../store-credit';
import { writeSale, getSale } from '../sale/sale.service';
import { shiftFor } from '../shifts';
import { adjust, cameBack, StockChange } from '../stock';
import { saleReturned, saleExchanged } from '../events';
import { CreateExchangeInput, CreateReturnInput, RefundInput } from './returns.schema';

/**
 * Returns and exchanges. POS-RET-001..007, POS-EXC-001..005, POS-APR-004/005, POS-PAY-015.
 *
 * A return is a CREDIT NOTE against one original bill: which lines, how many, why, and how the
 * money goes back. An exchange is a return whose credit pays for a new bill, with only the
 * difference changing hands. Both are one transaction -- the credit note, its number, the refund,
 * the store credit and (for an exchange) the new bill are written together or not at all.
 *
 * NOTHING IS EVER DELETED OR EDITED. POS-SALE-012. A bill that was wrong is corrected by a credit
 * note against it, never by changing it. The original stays exactly as the customer's paper says,
 * and the credit note sits beside it with its own number. That is what an accountant, a GST
 * officer and an argument at the counter all need to be able to see.
 *
 * WHAT A RETURNED PIECE IS WORTH is what was actually paid for it on that bill -- after its share
 * of any discount -- never today's tag price. A saree bought at 20% off comes back at 20% off.
 *
 * STOCK AND CRM ARE NOT TOUCHED (POS-RET-008, -009, POS-EXC-006: BLOCKED). A sale in the POS does
 * not move stock either -- the Inventory seam is Phase 8 and CRM is not started. The credit note
 * holds everything either will need: which line, which item, how many, when.
 */

type Tx = Prisma.TransactionClient;

const MONEY: RefundMethod[] = ['CASH', 'UPI', 'CARD'];
const MONEY_PAID: PaymentMethod[] = ['CASH', 'UPI', 'CARD'];

// ------------------------------------------------------------------------------------------------
// Pure arithmetic
// ------------------------------------------------------------------------------------------------

/**
 * Pieces `from`..`to` of a line of `qty` pieces that came to `total`.
 *
 * CUMULATIVE, not per piece. A line of 3 that came to Rs 100.00 is worth 33.33, 33.34, 33.33 --
 * and whichever order the pieces come back in, the three refunds add to exactly 100.00, because
 * each is "what the first N are worth" minus "what the first N-1 were worth". Rounding a per-piece
 * price and multiplying would refund 99.99 or 100.02 for the whole line, and a shop that returns a
 * whole bill must pay back exactly what it took.
 */
export function shareOf(total: number, qty: number, from: number, to: number): number {
  if (qty <= 0) return 0;
  return Math.round((total * to) / qty) - Math.round((total * from) / qty);
}

/**
 * The shop's return window, by calendar day in the shop's own time. POS-RET-004.
 *
 * "Seven days" means a saree bought on Monday can come back until the Monday after, all day --
 * not until the minute it was bought. That is how a shop says it and how a customer hears it.
 */
export function windowFor(soldAt: Date, days: number, now: Date = new Date()) {
  const start = new Date(soldAt);
  start.setHours(0, 0, 0, 0);
  const lastDay = new Date(start);
  lastDay.setDate(lastDay.getDate() + days);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return {
    days,
    lastDay,
    daysSince: Math.round((today.getTime() - start.getTime()) / 86_400_000),
    outside: today.getTime() > lastDay.getTime()
  };
}

type Window = ReturnType<typeof windowFor>;

/**
 * Who needs a manager. MASTER §8: a cashier needs approval for any return, and nobody without the
 * right may take one back after the window.
 *
 * Outside the window, the one approval covers both -- a manager who allows a late return is
 * allowing the return. Asking for two PINs for one saree is theatre.
 */
export function approvalNeeded(actor: Actor, window: Window): 'RETURN' | 'RETURN_OUTSIDE_WINDOW' | null {
  if (window.outside && !may(actor, PERMISSIONS.REFUND_OUTSIDE_WINDOW)) return 'RETURN_OUTSIDE_WINDOW';
  if (!may(actor, PERMISSIONS.REFUND)) return 'RETURN';
  return null;
}

// ------------------------------------------------------------------------------------------------
// Reading a bill for a return
// ------------------------------------------------------------------------------------------------

async function loadBill(db: Tx | typeof prisma, actor: Actor, saleId: string) {
  const sale = await db.sale.findFirst({
    where: { id: saleId, clientId: actor.clientId },
    select: {
      id: true, invoiceNo: true, createdAt: true, status: true, kind: true, fulfilment: true,
      totalPaise: true, roundOffPaise: true, customerId: true,
      customer: { select: { id: true, name: true, phone: true, storeCreditPaise: true } },
      lines: {
        select: {
          id: true, itemId: true, description: true, hsn: true, qty: true, unitPricePaise: true,
          taxRate: true, lineTotalPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true,
          // So the return screen can take a SCAN of the piece coming back, not only a tap.
          item: { select: { code: true, barcode: true } }
        }
      },
      payments: { select: { method: true, amountPaise: true, status: true } },
      returns: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, creditNoteNo: true, totalPaise: true, refundMethod: true, createdAt: true,
          exchangeSaleId: true,
          lines: { select: { saleLineId: true, qty: true } },
          refunds: { select: { method: true, amountPaise: true } }
        }
      }
    }
  });
  if (!sale) throw notFound('That bill was not found.');
  return sale;
}

type Bill = Awaited<ReturnType<typeof loadBill>>;

function returnedQty(bill: Bill) {
  const out = new Map<string, number>();
  for (const r of bill.returns) {
    for (const line of r.lines) out.set(line.saleLineId, (out.get(line.saleLineId) ?? 0) + line.qty);
  }
  return out;
}

/**
 * Why a bill cannot take a return at all, in words a cashier can act on. Null when it can.
 */
function blockedReason(bill: Bill): { code: string; message: string } | null {
  if (bill.status === 'RETURNED') {
    return { code: 'ALL_RETURNED', message: 'Everything on this bill has already been returned.' };
  }
  if (bill.status === 'PENDING_SYNC') {
    return { code: 'NOT_SYNCED', message: 'This bill has not reached the server yet. Try again once it has.' };
  }
  /*
   * A payment still being checked might never have arrived. Refunding it now could pay out money
   * the shop never received -- so the check comes first, on Payment checks.
   */
  if (bill.payments.some(p => p.status === 'NEEDS_CHECKING')) {
    return {
      code: 'PAYMENT_BEING_CHECKED',
      message: 'A payment on this bill is still being checked. Settle it on Payment checks first, so nothing is refunded that never arrived.'
    };
  }
  /*
   * A kept order with money still owed. Cancelling one fairly means working out what to do with
   * the advance and the debt together, which is a different decision from a return -- recorded as
   * open in FEATURES under POS-SALE-012 rather than guessed at here.
   */
  const owed = owedPaise(bill.totalPaise, bill.payments);
  if (owed > 0) {
    return {
      code: 'MONEY_OWED',
      message: `${rupees(owed)} is still owed on this bill. Collect it before anything comes back.`
    };
  }
  return null;
}

/**
 * How much of this bill may still go back as MONEY.
 *
 * Only what was paid in money, less what has already gone back as money. Store credit spent on a
 * bill and exchange credit both come back as store credit -- otherwise returning a saree bought with
 * credit is a way to turn credit into cash, and an exchange then a return is a way to turn a "no
 * cash refunds on exchanges" shop into one that gives them.
 */
function moneyRefundable(bill: Bill) {
  const paid = bill.payments
    .filter(p => p.status === 'COLLECTED' && MONEY_PAID.includes(p.method))
    .reduce((sum, p) => sum + p.amountPaise, 0);
  const refunded = bill.returns
    .flatMap(r => r.refunds)
    .filter(r => MONEY.includes(r.method))
    .reduce((sum, r) => sum + r.amountPaise, 0);
  return Math.max(0, paid - refunded);
}

export interface ComputedLine {
  saleLineId: string;
  itemId: string | null;
  description: string;
  hsn: string | null;
  qty: number;
  unitPricePaise: number;
  taxRate: number;
  amountPaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

export interface ComputedReturn {
  lines: ComputedLine[];
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  /** After this, nothing on the bill is left to return. */
  final: boolean;
}

/** Work out a return against a bill. Throws with the exact reason when a line cannot come back. */
function compute(bill: Bill, requested: { saleLineId: string; qty: number }[]): ComputedReturn {
  const seen = new Set<string>();
  for (const r of requested) {
    if (seen.has(r.saleLineId)) throw badRequest('The same line is listed twice. Send it once with the full quantity.');
    seen.add(r.saleLineId);
  }

  const already = returnedQty(bill);
  const byId = new Map(bill.lines.map(l => [l.id, l]));
  const lines: ComputedLine[] = [];

  for (const r of requested) {
    const line = byId.get(r.saleLineId);
    if (!line) throw badRequest('One of those lines is not on this bill.', { code: 'NOT_ON_BILL' });

    const before = already.get(line.id) ?? 0;
    const remaining = line.qty - before;
    // POS-RET-002. Never more than is left -- the one rule that stops the same saree coming back twice.
    if (r.qty > remaining) {
      throw conflict(
        remaining === 0
          ? `${line.description} has already been returned.`
          : `Only ${remaining} of ${line.description} can still come back. ${before} already ${before === 1 ? 'has' : 'have'}.`,
        { code: 'MORE_THAN_REMAINING', saleLineId: line.id, remainingQty: remaining }
      );
    }

    const after = before + r.qty;
    const cgst = shareOf(line.cgstPaise, line.qty, before, after);
    const sgst = shareOf(line.sgstPaise, line.qty, before, after);
    const igst = shareOf(line.igstPaise, line.qty, before, after);
    lines.push({
      saleLineId: line.id,
      itemId: line.itemId,
      description: line.description,
      hsn: line.hsn,
      qty: r.qty,
      unitPricePaise: line.unitPricePaise,
      taxRate: line.taxRate,
      amountPaise: shareOf(line.lineTotalPaise, line.qty, before, after),
      taxPaise: cgst + sgst + igst,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: igst
    });
  }

  const asked = new Map(requested.map(r => [r.saleLineId, r.qty]));
  const final = bill.lines.every(l => (already.get(l.id) ?? 0) + (asked.get(l.id) ?? 0) >= l.qty);

  /*
   * The bill's round-off comes back with the LAST piece, and only then. Every return before it
   * refunds exactly what its pieces were worth; the one that empties the bill adds the paise that
   * rounding took or gave, so the credit notes for a whole bill add up to what the customer paid.
   */
  const roundOffPaise = final ? bill.roundOffPaise : 0;
  const linesTotal = lines.reduce((sum, l) => sum + l.amountPaise, 0);

  return {
    lines,
    taxPaise: lines.reduce((sum, l) => sum + l.taxPaise, 0),
    roundOffPaise,
    totalPaise: linesTotal + roundOffPaise,
    final
  };
}

async function shopSettings(db: Tx | typeof prisma, clientId: string) {
  const settings = await db.shopSettings.findUnique({
    where: { clientId },
    select: { returnWindowDays: true, creditNotePrefix: true, enabledPaymentMethods: true }
  });
  return {
    returnWindowDays: settings?.returnWindowDays ?? 7,
    creditNotePrefix: settings?.creditNotePrefix ?? 'CN',
    enabledPaymentMethods: settings?.enabledPaymentMethods ?? []
  };
}

// ------------------------------------------------------------------------------------------------
// WF-RETURN-01: what can come back
// ------------------------------------------------------------------------------------------------

/**
 * Everything the return screen needs before anyone touches it. POS-RET-001, -002, -004.
 *
 * Whether the bill can take a return at all, and if not why; each line with how many can still
 * come back; the window; whether this person will need a manager; and how much can go back as
 * money. The screen shows all of it up front, so nobody fills in a return only to be refused.
 */
export async function eligibility(actor: Actor, saleId: string) {
  const [bill, settings] = await Promise.all([
    loadBill(prisma, actor, saleId),
    shopSettings(prisma, actor.clientId)
  ]);
  const already = returnedQty(bill);
  const window = windowFor(bill.createdAt, settings.returnWindowDays);
  const blocked = blockedReason(bill);

  return {
    saleId: bill.id,
    invoiceNo: bill.invoiceNo,
    soldAt: bill.createdAt,
    totalPaise: bill.totalPaise,
    blocked,
    window,
    approvalNeeded: approvalNeeded(actor, window),
    moneyRefundablePaise: moneyRefundable(bill),
    customer: bill.customer && {
      id: bill.customer.id,
      name: bill.customer.name,
      phoneMasked: maskPhone(bill.customer.phone),
      storeCreditPaise: bill.customer.storeCreditPaise
    },
    refundMethods: [
      ...MONEY.filter(m => settings.enabledPaymentMethods.length === 0 || settings.enabledPaymentMethods.includes(m as PaymentMethod)),
      'STORE_CREDIT' as const
    ],
    lines: bill.lines.map(line => {
      const returned = already.get(line.id) ?? 0;
      return {
        saleLineId: line.id,
        itemId: line.itemId,
        itemCode: line.item?.code ?? null,
        barcode: line.item?.barcode ?? null,
        description: line.description,
        qty: line.qty,
        returnedQty: returned,
        remainingQty: line.qty - returned,
        lineTotalPaise: line.lineTotalPaise
      };
    }),
    returns: bill.returns.map(r => ({
      id: r.id,
      creditNoteNo: r.creditNoteNo,
      totalPaise: r.totalPaise,
      refundMethod: r.refundMethod,
      exchangeSaleId: r.exchangeSaleId,
      createdAt: r.createdAt
    }))
  };
}

/**
 * The exact figure for a selection, before anything is written. The screen shows this as the
 * refund, so what the cashier tells the customer is what the credit note will say.
 */
export async function quote(actor: Actor, saleId: string, lines: { saleLineId: string; qty: number }[]) {
  const bill = await loadBill(prisma, actor, saleId);
  const blocked = blockedReason(bill);
  if (blocked) throw conflict(blocked.message, { code: blocked.code });
  return compute(bill, lines);
}

// ------------------------------------------------------------------------------------------------
// Recording a return or an exchange
// ------------------------------------------------------------------------------------------------

const linesKey = (lines: { saleLineId: string; qty: number }[]) =>
  lines.map(l => `${l.saleLineId}:${l.qty}`).sort().join('|');

type Mode =
  | { kind: 'RETURN'; input: CreateReturnInput }
  | { kind: 'EXCHANGE'; input: CreateExchangeInput };

export async function createReturn(actor: Actor, saleId: string, input: CreateReturnInput) {
  return run(actor, saleId, { kind: 'RETURN', input });
}

export async function createExchange(actor: Actor, saleId: string, input: CreateExchangeInput) {
  return run(actor, saleId, { kind: 'EXCHANGE', input });
}

async function run(actor: Actor, saleId: string, mode: Mode) {
  const { input } = mode;

  const existing = await findByOnceKey(input.onceKey);
  if (existing) return replay(actor, existing, saleId, input.lines);

  const pendingAudit: AuditEntry[] = [];
  const saleAudit: AuditEntry[] = [];

  try {
    const returnId = await prisma.$transaction(async (tx) => {
      /*
       * THE LOCK. Two cashiers returning the same saree at the same moment each read "1 left to
       * return" and each refund it. Reading what is left and writing the credit note have to be one
       * step, so the bill row is locked first and everything below is read after it.
       */
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sales WHERE id = ${saleId} AND client_id = ${actor.clientId} FOR UPDATE`;
      if (locked.length === 0) throw notFound('That bill was not found.');

      const [bill, settings] = await Promise.all([
        loadBill(tx, actor, saleId),
        shopSettings(tx, actor.clientId)
      ]);

      const blocked = blockedReason(bill);
      if (blocked) throw conflict(blocked.message, { code: blocked.code });

      const computed = compute(bill, input.lines);
      const window = windowFor(bill.createdAt, settings.returnWindowDays);

      // --- POS-APR-004, -005 ------------------------------------------------------------------
      const need = approvalNeeded(actor, window);
      let approvalId: string | null = null;
      let approvedById: string | null = null;
      const approvalDetail = {
        invoiceNo: bill.invoiceNo,
        totalPaise: computed.totalPaise,
        daysSince: window.daysSince,
        windowDays: window.days
      };

      if (need) {
        if (!input.approval) {
          throw forbidden(
            need === 'RETURN_OUTSIDE_WINDOW'
              ? `This bill is ${window.daysSince} days old and the shop takes returns for ${window.days}. A manager needs to approve it.`
              : 'A manager needs to approve this return.',
            { code: 'APPROVAL_REQUIRED', kind: need, ...approvalDetail }
          );
        }
        const granted = await grant(actor, {
          kind: need,
          pin: input.approval.pin,
          reason: input.approval.reason,
          detail: approvalDetail
        }, tx);
        approvalId = granted.id;
        approvedById = granted.approvedBy.id;
        pendingAudit.push({
          action: 'approval.granted',
          detail: {
            kind: need,
            reason: granted.reason,
            approvedBy: granted.approvedBy.name,
            approvedById: granted.approvedBy.id,
            ...approvalDetail
          }
        });
      } else if (window.outside) {
        // Allowed on their own authority -- still worth a line for the owner.
        pendingAudit.push({ action: 'approval.granted', detail: { kind: 'RETURN_OUTSIDE_WINDOW', byOwnAuthority: true, ...approvalDetail } });
      }

      // --- whose store credit, if it comes to that ---------------------------------------------
      const customerId = await resolveCustomer(tx, actor, bill, input.customerId);

      // --- POS-RET-006. The credit note's own series, inside this transaction: no gaps. -------
      const allocated = await nextNumber(tx, actor.clientId, 'CREDIT_NOTE', settings.creditNotePrefix);

      const created = await tx.return.create({
        data: {
          clientId: actor.clientId,
          creditNoteNo: allocated.number,
          financialYear: allocated.financialYear,
          originalSaleId: bill.id,
          cashierId: actor.kind === 'USER' ? actor.id : null,
          reason: input.reason,
          refundMethod: mode.kind === 'EXCHANGE' ? 'EXCHANGE' : mode.input.refund.method,
          totalPaise: computed.totalPaise,
          taxPaise: computed.taxPaise,
          roundOffPaise: computed.roundOffPaise,
          customerId,
          approvedById,
          onceKey: input.onceKey,
          lines: {
            create: computed.lines.map(l => ({
              saleLineId: l.saleLineId,
              qty: l.qty,
              amountPaise: l.amountPaise,
              taxPaise: l.taxPaise,
              cgstPaise: l.cgstPaise,
              sgstPaise: l.sgstPaise,
              igstPaise: l.igstPaise
            }))
          }
        },
        select: { id: true }
      });

      if (approvalId) {
        await tx.approval.update({ where: { id: approvalId }, data: { returnId: created.id } });
      }

      // --- POS-EXC-001..005. The new bill, paid first by what came back. -----------------------
      const refunds: { method: RefundMethod; amountPaise: number; reference: string | null }[] = [];
      let leftover = computed.totalPaise;
      let exchangeInvoiceNo: string | null = null;
      let goingOut: StockChange[] = [];

      if (mode.kind === 'EXCHANGE') {
        const written = await writeSale(tx, actor, {
          ...mode.input.newSale,
          onceKey: `${input.onceKey}:sale`,
          // The new bill belongs to the same person, unless the original had nobody on it.
          customerId: customerId ?? undefined,
          approval: input.approval
        }, saleAudit, { exchangeCreditPaise: computed.totalPaise });

        exchangeInvoiceNo = written.invoiceNo;
        goingOut = written.stockChanges;
        await tx.return.update({ where: { id: created.id }, data: { exchangeSaleId: written.saleId } });
        if (written.appliedCreditPaise > 0) {
          refunds.push({ method: 'EXCHANGE', amountPaise: written.appliedCreditPaise, reference: null });
        }
        leftover = computed.totalPaise - written.appliedCreditPaise;
      }

      // --- POS-RET-007, POS-PAY-015. Whatever is left goes back. -------------------------------
      if (leftover > 0) {
        const refund: RefundInput | undefined = mode.input.refund;
        if (!refund) {
          throw badRequest(
            `What came back is worth ${rupees(leftover)} more than the new bill. Choose how to give that back.`,
            { code: 'REFUND_METHOD_REQUIRED', leftoverPaise: leftover }
          );
        }

        if (refund.method === 'STORE_CREDIT') {
          if (!customerId) {
            throw badRequest('Store credit is kept against a phone number. Add the customer first.', {
              code: 'CUSTOMER_REQUIRED'
            });
          }
          await addCredit(tx, actor, customerId, leftover, { returnId: created.id });
          refunds.push({ method: 'STORE_CREDIT', amountPaise: leftover, reference: null });
        } else {
          checkMoneyRefund(bill, settings.enabledPaymentMethods, refund, leftover);
          refunds.push({ method: refund.method, amountPaise: leftover, reference: refund.reference?.trim() || null });
        }
      }

      if (refunds.length > 0) {
        // A cash refund comes out of the drawer open at this counter. POS-SHIFT-005.
        const shiftId = await shiftFor(
          tx, actor, mode.kind === 'EXCHANGE' ? mode.input.newSale.counterId : mode.input.counterId
        );
        await tx.returnRefund.createMany({
          data: refunds.map(r => ({ clientId: actor.clientId, returnId: created.id, shiftId, ...r }))
        });
      }

      /*
       * The pieces come back into the shop's count (and, for an exchange, the new ones go out) in
       * ONE ordered pass. Then one event: sale.exchanged for an exchange, sale.returned otherwise
       * -- never both, or a stock consumer would move the same pieces twice. POS-RET-008 / EXC-006
       * are the delivery of these to Inventory.
       */
      await adjust(tx, actor.clientId, [
        ...cameBack(computed.lines.map(l => ({ itemId: l.itemId, qty: l.qty }))),
        ...goingOut
      ]);
      if (mode.kind === 'EXCHANGE') await saleExchanged(tx, actor.clientId, created.id);
      else await saleReturned(tx, actor.clientId, created.id);

      // Everything is back: the bill says so. A partly returned bill stays as it was -- its
      // credit notes carry the detail.
      if (computed.final) {
        await tx.sale.update({ where: { id: bill.id }, data: { status: 'RETURNED' } });
      }

      pendingAudit.push({
        action: mode.kind === 'EXCHANGE' ? 'exchange.created' : 'return.created',
        detail: {
          invoiceNo: bill.invoiceNo,
          totalPaise: computed.totalPaise,
          reason: input.reason,
          pieces: computed.lines.reduce((sum, l) => sum + l.qty, 0),
          refunds: refunds.map(r => ({ method: r.method, amountPaise: r.amountPaise })),
          outsideWindow: window.outside,
          ...(exchangeInvoiceNo ? { newInvoiceNo: exchangeInvoiceNo } : {})
        }
      });

      return created.id;
    }, { timeout: 30_000, maxWait: 15_000 });

    const note = await getReturn(actor, returnId);

    // Committed. Now the audit trail may say so.
    for (const entry of pendingAudit) await record(actor, { ...entry, subject: note.creditNoteNo });
    for (const entry of saleAudit) await record(actor, { ...entry, subject: note.exchangeSale?.invoiceNo ?? null });

    return {
      replayed: false,
      creditNote: note,
      sale: note.exchangeSale ? await getSale(actor, note.exchangeSale.id) : null
    };
  } catch (error: any) {
    // Lost the race with the same key: the other request recorded it, and that is the answer.
    const winner = await findByOnceKey(input.onceKey).catch(() => null);
    if (winner) return replay(actor, winner, saleId, input.lines);
    throw error;
  }
}

/**
 * Whose store credit. The bill's own customer if it has one -- credit for a bill goes to the
 * person on it, not to whoever is standing at the counter. A bill with nobody on it takes the
 * customer given now.
 */
async function resolveCustomer(tx: Tx, actor: Actor, bill: Bill, given?: string) {
  if (bill.customerId) {
    if (given && given !== bill.customerId) {
      throw badRequest('This bill already belongs to a customer, and any credit goes to them.', {
        code: 'DIFFERENT_CUSTOMER'
      });
    }
    return bill.customerId;
  }
  if (!given) return null;
  const found = await tx.customer.findFirst({
    where: { id: given, clientId: actor.clientId, deletedAt: null },
    select: { id: true }
  });
  if (!found) throw notFound('That customer was not found. Look them up again.');
  return found.id;
}

function checkMoneyRefund(bill: Bill, enabled: PaymentMethod[], refund: RefundInput, amountPaise: number) {
  const method = refund.method as PaymentMethod;
  if (enabled.length > 0 && !enabled.includes(method)) {
    throw badRequest(`This shop is not set up to give refunds by ${pretty(method)}.`);
  }
  if ((method === 'UPI' || method === 'CARD') && !(refund.reference ?? '').trim()) {
    throw badRequest(`Add the ${pretty(method)} refund reference.`, { code: 'REFERENCE_REQUIRED', method });
  }
  const cap = moneyRefundable(bill);
  if (amountPaise > cap) {
    throw conflict(
      cap === 0
        ? 'Nothing on this bill was paid in money, so this can only go back as store credit.'
        : `Only ${rupees(cap)} of this bill was paid in money, so ${rupees(amountPaise)} cannot go back as ${pretty(method)}. Give it as store credit.`,
      { code: 'REFUND_OVER_MONEY_PAID', moneyRefundablePaise: cap, wantedPaise: amountPaise }
    );
  }
}

async function findByOnceKey(onceKey: string) {
  return prisma.return.findUnique({
    where: { onceKey },
    select: {
      id: true, clientId: true, originalSaleId: true, creditNoteNo: true,
      lines: { select: { saleLineId: true, qty: true } }
    }
  });
}

async function replay(
  actor: Actor,
  existing: NonNullable<Awaited<ReturnType<typeof findByOnceKey>>>,
  saleId: string,
  lines: { saleLineId: string; qty: number }[]
) {
  // A key from another shop is somebody else's return, and says nothing about this one.
  if (existing.clientId !== actor.clientId) throw conflict('That return key is already in use. Start the return again.');
  if (existing.originalSaleId !== saleId || linesKey(existing.lines) !== linesKey(lines)) {
    throw conflict(
      `This return was already recorded as ${existing.creditNoteNo}. Start a new return for anything else.`,
      { code: 'RETURN_ALREADY_RECORDED', returnId: existing.id, creditNoteNo: existing.creditNoteNo }
    );
  }
  const note = await getReturn(actor, existing.id);
  return {
    replayed: true,
    creditNote: note,
    sale: note.exchangeSale ? await getSale(actor, note.exchangeSale.id) : null
  };
}

// ------------------------------------------------------------------------------------------------
// The credit note, as it prints
// ------------------------------------------------------------------------------------------------

/** One credit note. POS-RET-006. Read from what was saved, never recomputed. */
export async function getReturn(actor: Actor, returnId: string) {
  const row = await prisma.return.findFirst({
    where: { id: returnId, clientId: actor.clientId },
    select: {
      id: true, creditNoteNo: true, financialYear: true, createdAt: true, reason: true,
      refundMethod: true, totalPaise: true, taxPaise: true, roundOffPaise: true, approvedById: true,
      cashier: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true, phone: true, storeCreditPaise: true } },
      originalSale: { select: { id: true, invoiceNo: true, createdAt: true } },
      exchangeSale: { select: { id: true, invoiceNo: true, totalPaise: true } },
      lines: {
        select: {
          qty: true, amountPaise: true, taxPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true,
          saleLine: { select: { id: true, description: true, hsn: true, unitPricePaise: true, taxRate: true } }
        }
      },
      refunds: { orderBy: { createdAt: 'asc' }, select: { method: true, amountPaise: true, reference: true } }
    }
  });
  if (!row) throw notFound('That credit note was not found.');

  const [approver, shop] = await Promise.all([
    row.approvedById
      ? prisma.user.findFirst({ where: { id: row.approvedById, clientId: actor.clientId }, select: { name: true } })
      : null,
    prisma.shopSettings.findUnique({
      where: { clientId: actor.clientId },
      select: { shopName: true, gstin: true, address: true, logoUrl: true, receiptFooter: true }
    })
  ]);

  return {
    id: row.id,
    creditNoteNo: row.creditNoteNo,
    financialYear: row.financialYear,
    createdAt: row.createdAt,
    reason: row.reason,
    refundMethod: row.refundMethod,
    totalPaise: row.totalPaise,
    taxPaise: row.taxPaise,
    roundOffPaise: row.roundOffPaise,
    cashier: row.cashier,
    approvedBy: approver?.name ?? null,
    customer: row.customer && {
      id: row.customer.id,
      name: row.customer.name,
      phoneMasked: maskPhone(row.customer.phone),
      storeCreditPaise: row.customer.storeCreditPaise
    },
    originalSale: row.originalSale,
    exchangeSale: row.exchangeSale,
    lines: row.lines.map(l => ({
      saleLineId: l.saleLine.id,
      description: l.saleLine.description,
      hsn: l.saleLine.hsn,
      unitPricePaise: l.saleLine.unitPricePaise,
      taxRate: l.saleLine.taxRate,
      qty: l.qty,
      amountPaise: l.amountPaise,
      taxPaise: l.taxPaise,
      cgstPaise: l.cgstPaise,
      sgstPaise: l.sgstPaise,
      igstPaise: l.igstPaise
    })),
    refunds: row.refunds,
    shop: shop ?? null
  };
}
