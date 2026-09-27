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

    const saleId = await prisma.$transaction(async (tx) => {
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
      const planned = planPayments(
        priced.totalPaise,
        input.payments,
        settings?.enabledPaymentMethods ?? [],
        // A kept order takes an advance -- anything from nothing up to the bill. POS-ORD-002.
        isKept ? 'ADVANCE' : 'EXACT'
      );

      // What the customer still owes once these payments are in. A payment still being checked is
      // not owed -- see owedPaise for why that matters.
      const owed = owedPaise(priced.totalPaise, planned);

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

      // 5.
      const sale = await tx.sale.create({
        data: {
          clientId: actor.clientId,
          invoiceNo: allocated.number,
          financialYear: allocated.financialYear,
          counterId: input.counterId,
          cashierId: actor.kind === 'USER' ? actor.id : null,
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
          // One key per payment, derived from the sale's. A retry writes the same rows or none.
          onceKey: `${input.onceKey}:pay:${index}`
        }))
      });

      return sale.id;
    }, { timeout: 30_000, maxWait: 15_000 });

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
  const [sale, lines, payments, shop] = await Promise.all([
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
        customer: { select: { id: true, name: true, phone: true, gstin: true } }
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
    })
  ]);

  if (!sale) throw notFound('That bill was not found.');

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
    lines,
    payments,
    shop: shop ?? null
  };
}
