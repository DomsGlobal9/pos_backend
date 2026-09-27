import { Prisma, PaymentMethod, SaleStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { notFound } from '../../utils/httpError';
import { literal } from '../../utils/likeText';

/**
 * Finding a bill that has already been made. POS-SALE-001..011, POS-RCPT-003, -004.
 *
 * The other half of the Phase 1 gate: a sale can be MADE, FOUND and REPRINTED. Making it was built
 * first; this is finding it again, which is what a shop actually does all day -- a customer comes
 * back with a receipt, or without one and only a phone number.
 *
 * WHY THIS IS NOT PART OF services/sale. A sale is written once, in a transaction, and read back
 * immediately. A bill is searched, filtered and paged over months by someone who was not there when
 * it was made. Different reason to change, so a different folder -- and every service here is a
 * folder, with no loose files.
 */

const PAGE = 25;

export interface BillFilters {
  /** Invoice number, or the tail of one. Also matches a customer's phone. */
  q?: string;
  from?: Date;
  to?: Date;
  method?: PaymentMethod;
  status?: SaleStatus;
  /** Opaque cursor: the id of the last row of the previous page. */
  after?: string;
}

export interface BillRow {
  id: string;
  invoiceNo: string;
  createdAt: Date;
  totalPaise: number;
  status: SaleStatus;
  itemCount: number;
  customerName: string | null;
  /** Distinct methods on the bill, so the list can show "Cash" or "Cash + UPI" without a join per row. */
  methods: PaymentMethod[];
  printCount: number;
}

export interface BillPage {
  bills: BillRow[];
  /** Pass back as `after` for the next page. Null when this is the end. */
  nextCursor: string | null;
}

/**
 * The bill list.
 *
 * Keyset paging on (createdAt, id) rather than skip/take. A shop scrolling its own history is
 * paging over a table that is being written to at the same time -- an offset page silently repeats
 * or skips a bill every time a new sale lands mid-scroll, and the one it skips is the one nobody
 * notices until they cannot find it.
 */
export async function list(actor: Actor, filters: BillFilters = {}): Promise<BillPage> {
  const where: Prisma.SaleWhereInput = { clientId: actor.clientId };

  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lt: filters.to } : {})
    };
  }
  if (filters.status) where.status = filters.status;
  // A bill "paid by UPI" is one with a UPI row on it. A split bill matches both of its methods,
  // which is what someone reconciling a card machine's day expects.
  if (filters.method) where.payments = { some: { method: filters.method } };

  const q = (filters.q ?? '').trim().slice(0, 60);
  if (q) {
    where.OR = [
      { invoiceNo: { contains: literal(q), mode: 'insensitive' } },
      // POS-SALE-003. Customers arrive in Phase 3; the path is real and returns nothing until then.
      { customer: { phone: { contains: literal(q) } } },
      { customer: { name: { contains: literal(q), mode: 'insensitive' } } }
    ];
  }

  // The cursor row itself is excluded by `skip: 1`, so a page boundary never repeats a bill.
  const rows = await prisma.sale.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE + 1,
    ...(filters.after ? { cursor: { id: filters.after }, skip: 1 } : {}),
    select: {
      id: true, invoiceNo: true, createdAt: true, totalPaise: true, status: true,
      printCount: true,
      customer: { select: { name: true } },
      payments: { select: { method: true } },
      _count: { select: { lines: true } }
    }
  });

  const hasMore = rows.length > PAGE;
  const page = hasMore ? rows.slice(0, PAGE) : rows;

  return {
    bills: page.map(sale => ({
      id: sale.id,
      invoiceNo: sale.invoiceNo,
      createdAt: sale.createdAt,
      totalPaise: sale.totalPaise,
      status: sale.status,
      itemCount: sale._count.lines,
      customerName: sale.customer?.name ?? null,
      methods: [...new Set(sale.payments.map(p => p.method))],
      printCount: sale.printCount
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
}

/**
 * Record that a bill was printed. POS-RCPT-004.
 *
 * Returns the number of the copy just taken -- 1 is the original, 2 and up are duplicates, and the
 * receipt prints "DUPLICATE" on anything above 1. Two identical-looking copies of one invoice is
 * how the same saree gets returned twice.
 *
 * Deliberately NOT inside the sale's own transaction: printing happens long after, can happen many
 * times, and must never be able to fail a sale. It is also not idempotent on purpose -- three
 * presses of Print means three copies exist in the world, and the count should say so.
 */
export async function recordPrint(actor: Actor, saleId: string): Promise<{ copyNumber: number }> {
  const updated = await prisma.sale.updateMany({
    where: { id: saleId, clientId: actor.clientId },
    data: { printCount: { increment: 1 }, lastPrintedAt: new Date() }
  });
  if (updated.count === 0) throw notFound('That bill was not found.');

  const sale = await prisma.sale.findFirst({
    where: { id: saleId, clientId: actor.clientId },
    select: { printCount: true }
  });
  return { copyNumber: sale?.printCount ?? 1 };
}
