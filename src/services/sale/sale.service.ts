import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { Actor } from '../../types/actor';
import { priceBasket, BasketLine } from '../basket';
import { forSale } from '../items';
import { nextNumber } from '../invoice-series';
import { rupees, applyPercent } from '../money';
import { planPayments, owedPaise } from '../payments';
import { grant, attachToSale } from '../approvals';
import { record, AuditEntry } from '../audit';
import { spendCredit } from '../store-credit';
import { shiftFor } from '../shifts';
import { may, PERMISSIONS } from '../../types/actor';
import { CompleteSaleInput } from './sale.schema';

/**
 * Completing a sale.
 *
 * ONE TRANSACTION. The number, the bill, its lines and the money are all written together or not at
 * all. Split into separate requests -- write the order, then the payment -- a dropped connection
 * between any two leaves a shop with goods gone and no money recorded, or a number burned on a bill
 * that does not exist. Inventory's counter sale is built the same way and for the same reason.
 *
 * Inside it, in this order:
 *   1. the prices, re-read from the database (never from the browser)
 *   2. the basket priced -- discounts, tax taken back out, rounding
 *   3. the payments checked against the bill it actually came to
 *   4. the invoice number, taken with the increment that IS the read
 *   5. the sale, its lines and its payments
 *
 * THE SAME SALE TWICE. The till makes one onceKey per basket. Pressing Complete twice, a retry
 * after a timeout, and the offline outbox flushing the same bill all find or become the one sale:
 * the second attempt gets the first sale back, never a second bill, a second number or a second
 * payment. The same key with a DIFFERENT basket is refused -- that is a bug or a stale screen, and
 * guessing which basket was meant charges somebody wrongly.
 */

const basketKey = (lines: { itemId: string; qty: number }[]) =>
  lines.map(l => `${l.itemId}:${l.qty}`).sort().join('|');

export async function completeSale(actor: Actor, input: CompleteSaleInput) {
  const existing = await findByOnceKey(actor.clientId, input.onceKey);
  if (existing) return replay(actor, existing, input);

  const isKept = input.kind === 'KEPT';

  /*
   * A KEPT ORDER NEEDS A CUSTOMER. POS-ORD-001.
   *
   * The one place in the POS where a customer is required, and the reason is practical rather
   * than a rule for its own sake: the shop is holding goods for somebody and may be owed money by
   * them. "The lady in the green saree" is not someone you can hand a blouse to next Saturday.
   *
   * An ordinary sale still never needs one. That rule does not bend.
   */
  if (isKept && !input.customerId) {
    throw badRequest('Choose who this is being kept for. A kept order needs a customer.', {
      code: 'CUSTOMER_REQUIRED'
    });
  }

  if (input.promisedAt) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    // A date that has already passed is a typo, not a promise.
    if (input.promisedAt < startOfToday) {
      throw badRequest('The collection date has already passed. Choose today or later.');
    }
  }

  try {
    /*
     * AUDIT ENTRIES ARE COLLECTED HERE AND WRITTEN ONLY AFTER THE SALE COMMITS.
     *
     * The first version wrote them from inside the transaction using the global client -- which
     * is NOT part of the transaction -- so a sale that failed on its payment rolled back while its
     * audit row stayed, recording a discount that was never given on a sale that does not exist.
     * Caught by a test written to check exactly that. An audit trail that records things which did
     * not happen is worse than none, because people believe it.
     */
    const pendingAudit: AuditEntry[] = [];

    const saleId = await prisma.$transaction(
      async (tx) => (await writeSale(tx, actor, input, pendingAudit)).saleId,
      { timeout: 30_000, maxWait: 15_000 }
    );

    const made = await getSale(actor, saleId);

    // Committed. Now, and only now, the audit trail may say it happened.
    for (const entry of pendingAudit) {
      await record(actor, { ...entry, subject: made.invoiceNo });
    }

    return { replayed: false, sale: made };
  } catch (error: any) {
    /*
     * Lost a race with the same onceKey: the other request made the sale, and that IS the answer.
     * Losing this race is not an error -- it is the unique constraint doing exactly its job.
     */
    const winner = await findByOnceKey(actor.clientId, input.onceKey).catch(() => null);
    if (winner) return replay(actor, winner, input);
    throw error;
  }
}

export interface WriteSaleOptions {
  /**
   * An exchange's credit: what the goods brought back came to. POS-EXC-004.
   *
   * It pays for the new bill first; the payments sent cover only what is left. When the credit is
   * more than the new bill, nothing is paid and the caller refunds the rest.
   */
  exchangeCreditPaise?: number;
}

export interface WrittenSale {
  saleId: string;
  invoiceNo: string;
  totalPaise: number;
  /** How much of the exchange credit this bill used. Zero outside an exchange. */
  appliedCreditPaise: number;
}

/**
 * Steps 1 to 5, inside a transaction the CALLER owns.
 *
 * Split out of completeSale for the exchange (Phase 6): the new bill of an exchange is an ordinary
 * sale in every way -- the same prices from the database, the same discount limit and approvals,
 * the same numbering -- and it has to commit together with the credit note that pays for part of
 * it. One function, so an exchange can never price a saree differently from the counter.
 */
export async function writeSale(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: CompleteSaleInput,
  pendingAudit: AuditEntry[],
  options: WriteSaleOptions = {}
): Promise<WrittenSale> {
  const isKept = input.kind === 'KEPT';
  const exchange = options.exchangeCreditPaise !== undefined;
  if (exchange && isKept) {
    throw badRequest('An exchange is settled at the counter. It cannot be kept for later.');
  }

  /*
   * STORE CREDIT NEEDS TO KNOW WHOSE. POS-PAY-016. Checked before anything is priced, so the
   * cashier hears it before a PIN is asked for.
   */
  const creditPaise = input.payments
    .filter(p => p.method === 'CREDIT')
    .reduce((sum, p) => sum + p.amountPaise, 0);
  if (creditPaise > 0 && !input.customerId) {
    throw badRequest('Store credit belongs to a customer. Add the customer to the bill first.', {
      code: 'CUSTOMER_REQUIRED'
    });
  }

  {
      // 1. Prices from the database. The browser sent ids and quantities and nothing else.
      const items = await forSale(tx, actor.clientId, input.lines.map(l => l.itemId));

      const overridden: { code: string; wasPaise: number; nowPaise: number }[] = [];

      const basket: BasketLine[] = input.lines.map(line => {
        const item = items.get(line.itemId);
        if (!item) {
          throw notFound('One of the items on this bill is no longer in the item list. Take it off and try again.');
        }
        if (!item.active) {
          throw conflict(`${item.name} is no longer sold. Take it off the bill.`);
        }

        /*
         * The tag price wins unless somebody deliberately overrode it. That default is the whole
         * defence: a browser can only change a price by saying so out loud, in a field that
         * demands a permission, a reason and a manager.
         */
        let unitPricePaise = item.pricePaise;
        if (line.overridePricePaise !== undefined && line.overridePricePaise !== item.pricePaise) {
          overridden.push({
            code: item.code, wasPaise: item.pricePaise, nowPaise: line.overridePricePaise
          });
          unitPricePaise = line.overridePricePaise;
        }

        return {
          ref: item.id,
          description: [item.name, item.colour, item.size].filter(Boolean).join(', '),
          hsn: item.hsn,
          qty: line.qty,
          unitPricePaise,
          taxRate: item.taxRate,
          lineDiscountPaise: line.lineDiscountPaise
        };
      });

      const settings = await tx.shopSettings.findUnique({
        where: { clientId: actor.clientId },
        select: {
          invoicePrefix: true, enabledPaymentMethods: true, manualDiscountMaxPercent: true
        }
      });

      // 2.
      const priced = priceBasket(basket, {
        billDiscountPaise: input.billDiscountPaise,
        interState: input.interState
      });

      /*
       * WHAT NEEDS A MANAGER. POS-SELL-015, -016, -017.
       *
       * Two separate things, and a bill can need both:
       *
       *   - a discount larger than the shop's cashier limit (POS-SET-005)
       *   - any price override at all
       *
       * The limit is a percentage of what the tags come to, because that is how a shop owner
       * thinks about it -- "nobody gives away more than a tenth" -- and it is checked against the
       * bill as priced here, never against the figure the screen was showing.
       */
      const limitPercent = settings?.manualDiscountMaxPercent ?? 0;
      const allowedDiscount = applyPercent(priced.subtotalPaise, limitPercent);
      const discountOverLimit = priced.discountPaise > allowedDiscount;

      const needs: { kind: 'DISCOUNT_OVER_LIMIT' | 'PRICE_OVERRIDE'; detail: any }[] = [];

      if (discountOverLimit) {
        needs.push({
          kind: 'DISCOUNT_OVER_LIMIT',
          detail: {
            discountPaise: priced.discountPaise,
            allowedPaise: allowedDiscount,
            limitPercent,
            subtotalPaise: priced.subtotalPaise
          }
        });
      }
      if (overridden.length > 0) {
        needs.push({ kind: 'PRICE_OVERRIDE', detail: { lines: overridden } });
      }

      const approvalIds: string[] = [];
      for (const need of needs) {
        const permission = need.kind === 'DISCOUNT_OVER_LIMIT'
          ? PERMISSIONS.DISCOUNT_OVER_LIMIT
          : PERMISSIONS.PRICE_OVERRIDE;

        /*
         * Someone who is allowed to do it themselves does not need to ask. A manager selling at
         * the counter should not have to find a second manager -- but it is still audited, so the
         * record is the same either way.
         */
        if (may(actor, permission)) {
          pendingAudit.push({
            action: need.kind === 'DISCOUNT_OVER_LIMIT' ? 'sale.discount_over_limit' : 'sale.price_override',
            detail: { ...need.detail, byOwnAuthority: true }
          });
          continue;
        }

        if (!input.approval) {
          throw forbidden(
            need.kind === 'DISCOUNT_OVER_LIMIT'
              ? `A manager needs to approve a discount over ${limitPercent}%.`
              : 'A manager needs to approve a price change.',
            {
              code: 'APPROVAL_REQUIRED',
              kind: need.kind,
              ...need.detail
            }
          );
        }

        const granted = await grant(actor, {
          kind: need.kind,
          pin: input.approval.pin,
          reason: input.approval.reason,
          detail: need.detail
        }, tx);
        approvalIds.push(granted.id);

        /*
         * A manager's yes goes in the audit trail too, not only in the approvals table.
         *
         * The owner reads the AUDIT screen. The first version audited their own discounts but not
         * the ones their managers approved -- which is exactly backwards, since the approved ones
         * are what an owner is checking up on. Caught by a test.
         */
        pendingAudit.push({
          action: 'approval.granted',
          detail: {
            kind: need.kind,
            reason: granted.reason,
            approvedBy: granted.approvedBy.name,
            approvedById: granted.approvedBy.id,
            ...need.detail
          }
        });
      }

      /*
       * 3. The payments, against the bill as it was actually priced HERE -- not the figure the
       * screen was showing. Those differ whenever a price changed underneath an open till.
       *
       * All the rules live in services/payments: the split has to add up, a shop's disabled
       * methods cannot be used, UPI and card need a reference unless they are marked unconfirmed,
       * and cash can never be unconfirmed.
       */
      /*
       * In an exchange, the credit from the goods brought back pays first and the payments cover
       * only the difference. When the credit covers the whole bill there is nothing to pay, and a
       * payment sent anyway is a mistake -- it would be money taken that nobody owes.
       */
      const applied = exchange ? Math.min(options.exchangeCreditPaise!, priced.totalPaise) : 0;
      const due = priced.totalPaise - applied;

      let planned: ReturnType<typeof planPayments>;
      if (exchange && due === 0) {
        if (input.payments.length > 0) {
          throw conflict('The goods brought back cover this bill. Nothing more is to be paid.', {
            code: 'NOTHING_TO_PAY'
          });
        }
        planned = [];
      } else {
        planned = planPayments(
          due,
          input.payments,
          settings?.enabledPaymentMethods ?? [],
          // A kept order takes an advance -- anything from nothing up to the bill. POS-ORD-002.
          isKept ? 'ADVANCE' : 'EXACT'
        );
      }

      // What the customer still owes once these payments are in. A payment still being checked is
      // not owed -- see owedPaise for why that matters. Exchange credit is in hand.
      const owed = owedPaise(priced.totalPaise, [
        ...planned,
        ...(applied > 0 ? [{ amountPaise: applied, status: 'COLLECTED' as const }] : [])
      ]);

      /*
       * The customer, when there is one. Checked inside the transaction so a sale cannot be
       * attached to somebody else's customer, or to one deleted between the screen loading and
       * Complete being pressed.
       */
      if (input.customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: input.customerId, clientId: actor.clientId, deletedAt: null },
          select: { id: true }
        });
        if (!customer) {
          throw notFound('That customer was not found. Complete the sale without one, or add them again.');
        }
      }

      // 4. Inside this transaction, deliberately: a sale that fails takes its number with it, so
      // the series never gains a gap.
      const allocated = await nextNumber(tx, actor.clientId, 'INVOICE', settings?.invoicePrefix ?? 'INV');

      // The drawer this bill's cash goes into. POS-SHIFT-002, -005. Null when no shift is open on
      // the counter -- the sale still goes through, and the day close reports the cash separately.
      const shiftId = await shiftFor(tx, actor, input.counterId);

      // 5.
      const sale = await tx.sale.create({
        data: {
          clientId: actor.clientId,
          invoiceNo: allocated.number,
          financialYear: allocated.financialYear,
          counterId: input.counterId,
          cashierId: actor.kind === 'USER' ? actor.id : null,
          shiftId,
          customerId: input.customerId ?? null,
          kind: isKept ? 'KEPT' : 'COMPLETE',
          // The money view. A kept order with nothing owed is still kept -- it just is not due.
          status: owed > 0 ? 'BALANCE_DUE' : 'COMPLETED',
          // The goods view. A counter sale leaves with the customer; a kept order waits.
          fulfilment: isKept ? 'WAITING' : 'HANDED_OVER',
          handedOverAt: isKept ? null : new Date(),
          handedOverById: isKept ? null : (actor.kind === 'USER' ? actor.id : null),
          promisedAt: input.promisedAt ?? null,
          note: input.note ?? null,
          subtotalPaise: priced.subtotalPaise,
          discountPaise: priced.discountPaise,
          taxPaise: priced.taxPaise,
          roundOffPaise: priced.roundOffPaise,
          totalPaise: priced.totalPaise,
          savedPaise: priced.savedPaise,
          onceKey: input.onceKey,
          madeOfflineAt: input.madeOfflineAt ?? null,
          lines: {
            create: priced.lines.map(line => ({
              itemId: line.ref,
              description: line.description,
              hsn: line.hsn,
              qty: line.qty,
              unitPricePaise: line.unitPricePaise,
              // What the tag said, when it differed. Null on an ordinary line, so an override is
              // visible on the bill forever rather than looking like a normal price.
              listPricePaise: items.get(line.ref)?.pricePaise !== line.unitPricePaise
                ? items.get(line.ref)?.pricePaise ?? null
                : null,
              priceOverrideReason: items.get(line.ref)?.pricePaise !== line.unitPricePaise
                ? input.approval?.reason ?? 'Allowed by own authority'
                : null,
              discountPaise: line.discountPaise,
              taxRate: line.taxRate,
              taxPaise: line.taxPaise,
              cgstPaise: line.cgstPaise,
              sgstPaise: line.sgstPaise,
              igstPaise: line.igstPaise,
              lineTotalPaise: line.lineTotalPaise
            }))
          }
        },
        select: { id: true }
      });

      // The approvals that authorised this sale now point at it. An approval with no sale is a
      // manager's yes for something that never happened, and being able to see those matters.
      await attachToSale(tx, approvalIds, sale.id);

      await tx.payment.createMany({
        data: planned.map((payment, index) => ({
          clientId: actor.clientId,
          saleId: sale.id,
          method: payment.method,
          amountPaise: payment.amountPaise,
          reference: payment.reference,
          tenderedPaise: payment.tenderedPaise,
          changePaise: payment.changePaise,
          status: payment.status,
          shiftId,
          // One key per payment, derived from the sale's. A retry writes the same rows or none.
          onceKey: `${input.onceKey}:pay:${index}`
        }))
      });

      if (applied > 0) {
        await tx.payment.create({
          data: {
            clientId: actor.clientId,
            saleId: sale.id,
            method: 'EXCHANGE',
            amountPaise: applied,
            status: 'COLLECTED',
            shiftId,
            onceKey: `${input.onceKey}:exchange`
          }
        });
      }

      /*
       * Store credit comes off the customer's balance HERE, in the same transaction as the bill,
       * with the balance check inside the UPDATE. If it is not there, the whole sale rolls back --
       * number, lines and all -- and the cashier is told how much there really is.
       */
      if (creditPaise > 0) {
        await spendCredit(tx, actor, input.customerId!, creditPaise, { saleId: sale.id });
        pendingAudit.push({ action: 'store_credit.spent', detail: { amountPaise: creditPaise } });
      }

      return {
        saleId: sale.id,
        invoiceNo: allocated.number,
        totalPaise: priced.totalPaise,
        appliedCreditPaise: applied
      };
  }
}

async function findByOnceKey(clientId: string, onceKey: string) {
  return prisma.sale.findFirst({
    where: { clientId, onceKey },
    select: { id: true, invoiceNo: true, lines: { select: { itemId: true, qty: true } } }
  });
}

async function replay(
  actor: Actor,
  existing: { id: string; invoiceNo: string; lines: { itemId: string | null; qty: number }[] },
  input: CompleteSaleInput
) {
  const before = basketKey(existing.lines.map(l => ({ itemId: l.itemId ?? '', qty: l.qty })));
  if (before !== basketKey(input.lines)) {
    throw conflict(
      `This sale was already completed as ${existing.invoiceNo}. Start a new sale for a different basket.`,
      { code: 'SALE_ALREADY_COMPLETED', saleId: existing.id, invoiceNo: existing.invoiceNo }
    );
  }
  return { replayed: true, sale: await getSale(actor, existing.id) };
}

/**
 * One sale, as a receipt reads it.
 *
 * Read side by side rather than as one nested tree. Prisma answers a nested select one relation at
 * a time and each is a round trip -- to Singapore, from a shop, that is the difference between a
 * receipt appearing and a receipt being waited for. Every read is scoped to this shop, so a sale id
 * from another shop finds nothing in any of them.
 */
export async function getSale(actor: Actor, saleId: string) {
  const [sale, lines, payments, shop, returns, exchangedFrom] = await Promise.all([
    prisma.sale.findFirst({
      where: { id: saleId, clientId: actor.clientId },
      select: {
        id: true, invoiceNo: true, financialYear: true, kind: true, status: true, createdAt: true,
        subtotalPaise: true, discountPaise: true, taxPaise: true, roundOffPaise: true,
        totalPaise: true, savedPaise: true, madeOfflineAt: true,
        printCount: true, lastPrintedAt: true,
        fulfilment: true, promisedAt: true, note: true, readyAt: true,
        handedOverAt: true, handoverDuePaise: true,
        counter: { select: { id: true, name: true } },
        cashier: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, phone: true, gstin: true, storeCreditPaise: true } }
      }
    }),
    prisma.saleLine.findMany({
      where: { saleId, sale: { clientId: actor.clientId } },
      select: {
        id: true, description: true, hsn: true, qty: true, unitPricePaise: true,
        discountPaise: true, taxRate: true, taxPaise: true, lineTotalPaise: true,
        cgstPaise: true, sgstPaise: true, igstPaise: true
      }
    }),
    prisma.payment.findMany({
      where: { saleId, clientId: actor.clientId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, method: true, amountPaise: true, reference: true,
        tenderedPaise: true, changePaise: true, status: true,
        checkedAt: true, checkedNote: true
      }
    }),
    prisma.shopSettings.findUnique({
      where: { clientId: actor.clientId },
      select: { shopName: true, gstin: true, address: true, logoUrl: true, receiptFooter: true }
    }),
    // Phase 6. The credit notes against this bill, and which pieces each took back.
    prisma.return.findMany({
      where: { originalSaleId: saleId, clientId: actor.clientId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, creditNoteNo: true, totalPaise: true, refundMethod: true, createdAt: true,
        exchangeSale: { select: { id: true, invoiceNo: true } },
        lines: { select: { saleLineId: true, qty: true } }
      }
    }),
    // And, on the new bill of an exchange, the credit note that paid for part of it. POS-EXC-005.
    prisma.return.findFirst({
      where: { exchangeSaleId: saleId, clientId: actor.clientId },
      select: { id: true, creditNoteNo: true, originalSale: { select: { id: true, invoiceNo: true } } }
    })
  ]);

  if (!sale) throw notFound('That bill was not found.');

  const returned = new Map<string, number>();
  for (const r of returns) {
    for (const l of r.lines) returned.set(l.saleLineId, (returned.get(l.saleLineId) ?? 0) + l.qty);
  }

  const phone = sale.customer?.phone ?? null;
  return {
    ...sale,
    // POS-ORD-003. Derived from the payments every time, by the one function that defines it.
    owedPaise: owedPaise(sale.totalPaise, payments),
    customer: sale.customer && {
      ...sale.customer,
      // The receipt goes home with the customer and is often left on the counter.
      phoneMasked: phone ? `••••${phone.slice(-4)}` : null
    },
    lines: lines.map(line => ({ ...line, returnedQty: returned.get(line.id) ?? 0 })),
    payments,
    returns: returns.map(r => ({
      id: r.id,
      creditNoteNo: r.creditNoteNo,
      totalPaise: r.totalPaise,
      refundMethod: r.refundMethod,
      createdAt: r.createdAt,
      exchangeSale: r.exchangeSale
    })),
    returnedPaise: returns.reduce((sum, r) => sum + r.totalPaise, 0),
    exchangedFrom: exchangedFrom
      ? {
          returnId: exchangedFrom.id,
          creditNoteNo: exchangedFrom.creditNoteNo,
          originalSaleId: exchangedFrom.originalSale.id,
          originalInvoiceNo: exchangedFrom.originalSale.invoiceNo
        }
      : null,
    shop: shop ?? null
  };
}
