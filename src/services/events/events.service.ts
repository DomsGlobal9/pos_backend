import { Prisma } from '@prisma/client';

/**
 * What happened, told to everyone who needs to know. MASTER §7, §5.7.
 *
 * Each sale, return and exchange writes ONE event, inside the SAME transaction that writes the
 * bill. That is the whole reliability story, and it is the reason this is an outbox rather than a
 * call to Inventory from the sale:
 *
 *   - a sale that rolls back takes its event with it -- nobody is ever told about a bill that does
 *     not exist
 *   - a sale that commits always has its event -- nothing depends on a network call succeeding
 *     at the moment a customer is standing at the counter
 *   - a replayed sale (same once-key) writes nothing, because it never reaches this code again
 *
 * Delivery -- to Inventory (Phase 8, once its intake exists) and to a shop's own software (Phase
 * 12) -- reads these rows afterwards, retries safely, and never blocks the till.
 *
 * PUBLIC IDENTITIES ONLY. Invoice and credit-note numbers, item codes, phone numbers. Never our
 * uuids: a receiver's database must not be coupled to our primary keys (MASTER §3).
 *
 * AN EXCHANGE IS ONE EVENT, `sale.exchanged`, carrying both what came back and what went out. It
 * is deliberately NOT also a `sale.returned` plus a `sale.completed`: a stock consumer that handled
 * all three would move the same pieces twice.
 */

type Tx = Prisma.TransactionClient;

export const EVENT_VERSION = 1;

export type EventType = 'sale.completed' | 'sale.returned' | 'sale.exchanged';

async function write(tx: Tx, clientId: string, eventType: EventType, payload: Record<string, unknown>, invoiceNo: string) {
  await tx.webhookEvent.create({
    data: {
      clientId,
      eventType,
      eventVersion: EVENT_VERSION,
      invoiceNo,
      payload: payload as Prisma.InputJsonValue
    }
  });
}

const LINE_SELECT = {
  qty: true, description: true, hsn: true, unitPricePaise: true, discountPaise: true,
  taxRate: true, taxPaise: true, lineTotalPaise: true,
  item: { select: { code: true } }
} as const;

type SaleLineRow = Prisma.SaleLineGetPayload<{ select: typeof LINE_SELECT }>;

const saleLine = (l: SaleLineRow) => ({
  itemCode: l.item?.code ?? null,
  description: l.description,
  hsn: l.hsn,
  qty: l.qty,
  unitPricePaise: l.unitPricePaise,
  discountPaise: l.discountPaise,
  taxRate: l.taxRate,
  taxPaise: l.taxPaise,
  lineTotalPaise: l.lineTotalPaise
});

async function loadSale(tx: Tx, saleId: string) {
  return tx.sale.findUniqueOrThrow({
    where: { id: saleId },
    select: {
      invoiceNo: true, financialYear: true, createdAt: true, kind: true, fulfilment: true,
      subtotalPaise: true, discountPaise: true, taxPaise: true, roundOffPaise: true, totalPaise: true,
      counter: { select: { name: true } },
      cashier: { select: { name: true } },
      customer: { select: { phone: true, name: true } },
      lines: { select: LINE_SELECT },
      payments: { select: { method: true, amountPaise: true, status: true } }
    }
  });
}

/** sale.completed -- a bill. Written by writeSale, except for the new bill of an exchange. */
export async function saleCompleted(tx: Tx, clientId: string, saleId: string) {
  const s = await loadSale(tx, saleId);
  await write(tx, clientId, 'sale.completed', {
    invoiceNo: s.invoiceNo,
    financialYear: s.financialYear,
    occurredAt: s.createdAt.toISOString(),
    counter: s.counter.name,
    cashier: s.cashier?.name ?? null,
    // A kept order is sold at creation: the pieces are the customer's, even while still in the shop.
    kind: s.kind,
    fulfilment: s.fulfilment,
    customerRef: s.customer?.phone ?? null,
    // For Inventory's own customer record (contract §4.1, Q6). Its outside-customer rule may drop
    // a phone it already has on someone else -- that is correct there, not a mismatch here.
    customer: s.customer ? { name: s.customer.name, phone: s.customer.phone } : null,
    lines: s.lines.map(saleLine),
    totals: {
      subtotalPaise: s.subtotalPaise, discountPaise: s.discountPaise, taxPaise: s.taxPaise,
      roundOffPaise: s.roundOffPaise, totalPaise: s.totalPaise
    },
    payments: s.payments.map(p => ({ method: p.method, amountPaise: p.amountPaise, status: p.status }))
  }, s.invoiceNo);
}

async function loadReturn(tx: Tx, returnId: string) {
  return tx.return.findUniqueOrThrow({
    where: { id: returnId },
    select: {
      creditNoteNo: true, createdAt: true, reason: true, totalPaise: true, taxPaise: true, roundOffPaise: true,
      originalSale: { select: { invoiceNo: true } },
      customer: { select: { phone: true } },
      exchangeSaleId: true,
      lines: {
        select: {
          qty: true, amountPaise: true, taxPaise: true,
          saleLine: { select: { description: true, hsn: true, taxRate: true, item: { select: { code: true } } } }
        }
      },
      refunds: { select: { method: true, amountPaise: true } }
    }
  });
}

const returnedLine = (l: Awaited<ReturnType<typeof loadReturn>>['lines'][number]) => ({
  itemCode: l.saleLine.item?.code ?? null,
  description: l.saleLine.description,
  hsn: l.saleLine.hsn,
  qty: l.qty,
  taxRate: l.saleLine.taxRate,
  amountPaise: l.amountPaise,
  taxPaise: l.taxPaise
});

/** sale.returned -- a credit note that was not part of an exchange. */
export async function saleReturned(tx: Tx, clientId: string, returnId: string) {
  const r = await loadReturn(tx, returnId);
  await write(tx, clientId, 'sale.returned', {
    creditNoteNo: r.creditNoteNo,
    originalInvoiceNo: r.originalSale.invoiceNo,
    occurredAt: r.createdAt.toISOString(),
    reason: r.reason,
    customerRef: r.customer?.phone ?? null,
    lines: r.lines.map(returnedLine),
    totals: { totalPaise: r.totalPaise, taxPaise: r.taxPaise, roundOffPaise: r.roundOffPaise },
    refunds: r.refunds.map(x => ({ method: x.method, amountPaise: x.amountPaise }))
  }, r.creditNoteNo);
}

/**
 * sale.exchanged -- the credit note and the new bill as ONE event.
 *
 * `returned` is what came back into the shop; `taken` is what went out. `differencePaise` is what
 * the customer paid on top (positive) or was given back (negative).
 */
export async function saleExchanged(tx: Tx, clientId: string, returnId: string) {
  const r = await loadReturn(tx, returnId);
  if (!r.exchangeSaleId) throw new Error('saleExchanged called for a return that is not an exchange');
  const s = await loadSale(tx, r.exchangeSaleId);
  await write(tx, clientId, 'sale.exchanged', {
    creditNoteNo: r.creditNoteNo,
    originalInvoiceNo: r.originalSale.invoiceNo,
    newInvoiceNo: s.invoiceNo,
    occurredAt: r.createdAt.toISOString(),
    reason: r.reason,
    counter: s.counter.name,
    customerRef: s.customer?.phone ?? r.customer?.phone ?? null,
    customer: s.customer ? { name: s.customer.name, phone: s.customer.phone } : null,
    returned: r.lines.map(returnedLine),
    taken: s.lines.map(saleLine),
    creditPaise: r.totalPaise,
    newTotalPaise: s.totalPaise,
    differencePaise: s.totalPaise - r.totalPaise,
    payments: s.payments.filter(p => p.method !== 'EXCHANGE').map(p => ({ method: p.method, amountPaise: p.amountPaise, status: p.status })),
    refunds: r.refunds.filter(x => x.method !== 'EXCHANGE').map(x => ({ method: x.method, amountPaise: x.amountPaise }))
  }, r.creditNoteNo);
}
