import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { Actor } from '../../types/actor';
import { priceBasket, BasketLine } from '../basket';
import { forSale } from '../items';
import { nextNumber } from '../invoice-series';
import { changeDue, rupees } from '../money';
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

  try {
    const saleId = await prisma.$transaction(async (tx) => {
      // 1. Prices from the database. The browser sent ids and quantities and nothing else.
      const items = await forSale(tx, actor.clientId, input.lines.map(l => l.itemId));

      const basket: BasketLine[] = input.lines.map(line => {
        const item = items.get(line.itemId);
        if (!item) {
          throw notFound('One of the items on this bill is no longer in the item list. Take it off and try again.');
        }
        if (!item.active) {
          throw conflict(`${item.name} is no longer sold. Take it off the bill.`);
        }
        return {
          ref: item.id,
          description: [item.name, item.colour, item.size].filter(Boolean).join(', '),
          hsn: item.hsn,
          qty: line.qty,
          unitPricePaise: item.pricePaise,
          taxRate: item.taxRate,
          lineDiscountPaise: line.lineDiscountPaise
        };
      });

      const settings = await tx.shopSettings.findUnique({
        where: { clientId: actor.clientId },
        select: { invoicePrefix: true }
      });

      // 2.
      const priced = priceBasket(basket, {
        billDiscountPaise: input.billDiscountPaise,
        interState: input.interState
      });

      // 3. Against the bill as it was actually priced here, not the figure the screen was showing.
      // Those differ whenever a price changed underneath an open till.
      const paid = input.payments.reduce((sum, p) => sum + p.amountPaise, 0);
      if (paid !== priced.totalPaise) {
        throw conflict(
          `This bill comes to ${rupees(priced.totalPaise)} but ${rupees(paid)} was entered. ` +
          `Check the bill and the payment.`,
          { code: 'AMOUNT_MISMATCH', totalPaise: priced.totalPaise, paidPaise: paid }
        );
      }
      for (const payment of input.payments) {
        if (payment.method === 'CASH' && payment.tenderedPaise !== undefined
            && payment.tenderedPaise < payment.amountPaise) {
          throw badRequest(`Only ${rupees(payment.tenderedPaise)} was handed over for a ${rupees(payment.amountPaise)} payment.`);
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
          kind: 'COMPLETE',
          status: 'COMPLETED',
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

      await tx.payment.createMany({
        data: input.payments.map((payment, index) => ({
          clientId: actor.clientId,
          saleId: sale.id,
          method: payment.method,
          amountPaise: payment.amountPaise,
          reference: payment.reference ?? null,
          tenderedPaise: payment.method === 'CASH' ? payment.tenderedPaise ?? null : null,
          changePaise: payment.method === 'CASH' && payment.tenderedPaise !== undefined
            ? changeDue(payment.tenderedPaise, payment.amountPaise)
            : null,
          // One key per payment, derived from the sale's. A retry writes the same rows or none.
          onceKey: `${input.onceKey}:pay:${index}`
        }))
      });

      return sale.id;
    }, { timeout: 30_000, maxWait: 15_000 });

    return { replayed: false, sale: await getSale(actor, saleId) };
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
        tenderedPaise: true, changePaise: true
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
