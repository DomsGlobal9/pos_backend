import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { badRequest, notFound } from '../../utils/httpError';
import { literal, phoneDigits } from '../../utils/likeText';
import { normalisePhone, displayPhone, maskPhone, PhoneError } from '../../utils/phone';
import { owedByCustomer } from '../orders';
import { history as creditHistory, CreditEntry } from '../store-credit';
import { record } from '../audit';
import { gstinProblem, normaliseGstin } from '../../utils/gstin';

/**
 * The customer. POS-CUST-002..010, -014.
 *
 * STANDALONE TODAY. CRM is not built, so this table is the master and this service is the whole
 * truth about a customer. When CRM arrives it becomes what `Item` is to Inventory -- a cache in
 * front of someone else's master -- and that is why every function here is written as a lookup
 * that could be answered from somewhere else: nothing outside this folder knows where a customer
 * came from, so swapping the source later is a change in one place.
 *
 * TWO RULES THAT DO NOT BEND:
 *
 *   1. A SALE MUST BE POSSIBLE WITH NO CUSTOMER. Someone paying cash who will not give a number is
 *      a normal Saturday. Nothing in the sell path may require a customer id.
 *   2. THE POS IS NOT A CRM. What lives here is what a cashier needs to serve the person in front
 *      of them -- who they are, what they have bought, what they owe. Segmentation, campaigns and
 *      communication history belong to CRM and must not creep in here.
 */

const RECENT_PURCHASES = 5;
const SEARCH_LIMIT = 25;

export interface CustomerCard {
  id: string;
  phone: string;
  phoneDisplay: string;
  phoneMasked: string;
  name: string | null;
  gstin: string | null;
  address: string | null;
  note: string | null;
  marketingConsent: boolean;
  /** Both are the POS's own figures while standalone. See the schema comment before spending one. */
  loyaltyPoints: number;
  storeCreditPaise: number;
  /** POS-CUST-010. Counted from this shop's own sales. */
  visitCount: number;
  lifetimeSpentPaise: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}

export interface CustomerDetail extends CustomerCard {
  /** POS-CUST-011. What they owe across every kept order. Unblocked in Phase 5. */
  owedPaise: number;
  /** POS-CUST-012. Why their store credit is what it is. Newest first. */
  creditHistory: CreditEntry[];
  /** POS-CUST-009. */
  recent: {
    id: string;
    invoiceNo: string;
    totalPaise: number;
    itemCount: number;
    createdAt: Date;
    /** POS-CUST-015. RETURNED when everything came back; returnedPaise for part of it. */
    status: string;
    returnedPaise: number;
  }[];
}

function card(row: any, stats?: { count: number; total: number; first: Date | null; last: Date | null }): CustomerCard {
  return {
    id: row.id,
    phone: row.phone,
    phoneDisplay: displayPhone(row.phone),
    phoneMasked: maskPhone(row.phone),
    name: row.name,
    gstin: row.gstin,
    address: row.address ?? null,
    note: row.note ?? null,
    marketingConsent: row.marketingConsent ?? false,
    loyaltyPoints: row.loyaltyPoints ?? 0,
    storeCreditPaise: row.storeCreditPaise ?? 0,
    visitCount: stats?.count ?? 0,
    lifetimeSpentPaise: stats?.total ?? 0,
    firstSeenAt: stats?.first ?? null,
    lastSeenAt: stats?.last ?? null
  };
}

const SELECT = {
  id: true, phone: true, name: true, gstin: true, address: true, note: true,
  marketingConsent: true, loyaltyPoints: true, storeCreditPaise: true
} as const;

/**
 * POS-CUST-002. Find by the number, which is the identity.
 *
 * Returns null rather than throwing when nobody matches: "we have not met this person" is an
 * ordinary answer at a counter, not a failure. A number that cannot be made sense of IS an error,
 * because saving it would create a record nobody can find again.
 */
export async function findByPhone(actor: Actor, rawPhone: string): Promise<CustomerCard | null> {
  const phone = normalise(rawPhone);
  const row = await prisma.customer.findFirst({
    where: { clientId: actor.clientId, phone: phone.e164, deletedAt: null },
    select: SELECT
  });
  if (!row) return null;
  return card(row, await statsFor(actor.clientId, row.id));
}

/**
 * POS-CUST-004, -005, -006. Create in one step, from the sell screen, without leaving the sale.
 *
 * Find-or-create rather than create: two cashiers adding the same number at the same moment must
 * end with ONE customer, and a shop that has met this person before should not be asked to create
 * them again. The unique constraint on (clientId, phone) is what actually enforces it -- the read
 * is only there to answer quickly in the common case.
 */
export async function findOrCreate(
  actor: Actor,
  input: { phone: string; name?: string; gstin?: string; note?: string; marketingConsent?: boolean }
): Promise<{ customer: CustomerCard; created: boolean }> {
  const phone = normalise(input.phone);
  const name = input.name?.trim() || null;
  const gstin = input.gstin?.trim() ? normaliseGstin(input.gstin) : null;
  if (gstin) { const problem = gstinProblem(gstin); if (problem) throw badRequest(problem, { code: 'BAD_GSTIN' }); }

  const existing = await prisma.customer.findFirst({
    where: { clientId: actor.clientId, phone: phone.e164, deletedAt: null },
    select: SELECT
  });

  if (existing) {
    /*
     * A known number, and the cashier typed something. Fill in what is missing rather than
     * overwrite what is there: a customer who gave their full name once should not lose it because
     * someone typed "Priya" in a hurry the next time.
     *
     * Consent is the exception in the other direction -- it can be turned ON here and never off.
     */
    const patch: Prisma.CustomerUpdateInput = {};
    if (name && !existing.name) patch.name = name;
    if (gstin && !existing.gstin) patch.gstin = gstin;
    if (input.note?.trim()) patch.note = input.note.trim();
    if (input.marketingConsent && !existing.marketingConsent) {
      patch.marketingConsent = true;
      patch.consentAt = new Date();
    }

    const updated = Object.keys(patch).length
      ? await prisma.customer.update({ where: { id: existing.id }, data: patch, select: SELECT })
      : existing;

    return { customer: card(updated, await statsFor(actor.clientId, updated.id)), created: false };
  }

  try {
    const made = await prisma.customer.create({
      data: {
        clientId: actor.clientId,
        phone: phone.e164,
        name,
        gstin,
        note: input.note?.trim() || null,
        marketingConsent: input.marketingConsent === true,
        consentAt: input.marketingConsent === true ? new Date() : null
      },
      select: SELECT
    });
    return { customer: card(made, { count: 0, total: 0, first: null, last: null }), created: true };
  } catch (error: any) {
    // Lost the race. The other request made the customer, and that IS the answer -- exactly the
    // same shape as the sale's replay path.
    if (error?.code === 'P2002') {
      const winner = await prisma.customer.findFirst({
        where: { clientId: actor.clientId, phone: phone.e164 },
        select: SELECT
      });
      if (winner) {
        return { customer: card(winner, await statsFor(actor.clientId, winner.id)), created: false };
      }
    }
    throw error;
  }
}

/** POS-CUST-007. One box for a number or a name, because a shopkeeper should not have to say which. */
export async function search(actor: Actor, rawQuery: unknown): Promise<CustomerCard[]> {
  const q = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 60) : '';

  const where: Prisma.CustomerWhereInput = { clientId: actor.clientId, deletedAt: null };

  if (q) {
    const conditions: Prisma.CustomerWhereInput[] = [
      { name: { contains: literal(q), mode: 'insensitive' } }
    ];

    /*
     * The phone condition is added ONLY when there are digits to match.
     *
     * The first version fell back to a NUL byte as a "match nothing" sentinel, which Postgres
     * rejects outright -- searching any name with no digit in it crashed the whole screen with
     * `invalid byte sequence for encoding "UTF8": 0x00`. Found by searching for a name that does
     * not exist, which is the most ordinary thing a cashier can type.
     *
     * Digits only, so "98765 43210" and "9876543210" both find the stored +919876543210 -- and
     * only when what was typed IS a number (see phoneDigits).
     */
    const digits = phoneDigits(q);
    if (digits) conditions.push({ phone: { contains: digits } });

    where.OR = conditions;
  }

  const rows = await prisma.customer.findMany({
    where,
    select: SELECT,
    orderBy: { updatedAt: 'desc' },
    take: SEARCH_LIMIT
  });

  const stats = await statsForMany(actor.clientId, rows.map(r => r.id));
  return rows.map(r => card(r, stats.get(r.id)));
}

/** POS-CUST-008, -009, -010. Everything a cashier needs to serve this person, and nothing more. */
export async function detail(actor: Actor, customerId: string): Promise<CustomerDetail> {
  const [row, recent] = await Promise.all([
    prisma.customer.findFirst({
      where: { id: customerId, clientId: actor.clientId, deletedAt: null },
      select: SELECT
    }),
    prisma.sale.findMany({
      where: { clientId: actor.clientId, customerId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_PURCHASES,
      select: {
        id: true, invoiceNo: true, totalPaise: true, createdAt: true, status: true,
        _count: { select: { lines: true } },
        returns: { select: { totalPaise: true } }
      }
    })
  ]);

  if (!row) throw notFound('That customer was not found.');

  const [stats, owed, credits] = await Promise.all([
    statsFor(actor.clientId, customerId),
    owedByCustomer(actor.clientId, customerId),
    creditHistory(actor, customerId, 10)
  ]);

  return {
    ...card(row, stats),
    owedPaise: owed,
    creditHistory: credits,
    recent: recent.map(sale => ({
      id: sale.id,
      invoiceNo: sale.invoiceNo,
      totalPaise: sale.totalPaise,
      itemCount: sale._count.lines,
      createdAt: sale.createdAt,
      status: sale.status,
      returnedPaise: sale.returns.reduce((sum, r) => sum + r.totalPaise, 0)
    }))
  };
}

/**
 * Visit count and lifetime spend, derived rather than stored. POS-CUST-010.
 *
 * A stored counter drifts the first time a sale is voided or a return is processed, and then two
 * screens disagree about how often someone has visited. Counting the sales is always right, and at
 * the sizes a single shop reaches it is not worth the drift to avoid.
 *
 * Only COMPLETED and BALANCE_DUE count. A fully returned sale is not a visit anyone should be
 * rewarded for.
 */
async function statsFor(clientId: string, customerId: string) {
  const [result, back] = await Promise.all([
    prisma.sale.aggregate({
      where: { clientId, customerId, status: { in: ['COMPLETED', 'BALANCE_DUE'] } },
      _count: true,
      _sum: { totalPaise: true },
      _min: { createdAt: true },
      _max: { createdAt: true }
    }),
    // POS-CUST-015. What came back off those same bills. A fully returned bill is already left out
    // above, so only the part-returned ones are subtracted -- never the same money twice.
    prisma.return.aggregate({
      where: { clientId, originalSale: { customerId, status: { in: ['COMPLETED', 'BALANCE_DUE'] } } },
      _sum: { totalPaise: true }
    })
  ]);
  return {
    count: result._count ?? 0,
    total: (result._sum?.totalPaise ?? 0) - (back._sum?.totalPaise ?? 0),
    first: result._min?.createdAt ?? null,
    last: result._max?.createdAt ?? null
  };
}

/** The same figures for a list, in one query rather than one per row. */
async function statsForMany(clientId: string, customerIds: string[]) {
  const out = new Map<string, { count: number; total: number; first: Date | null; last: Date | null }>();
  if (customerIds.length === 0) return out;

  const grouped = await prisma.sale.groupBy({
    by: ['customerId'],
    where: {
      clientId,
      customerId: { in: customerIds },
      status: { in: ['COMPLETED', 'BALANCE_DUE'] }
    },
    _count: { _all: true },
    _sum: { totalPaise: true },
    _min: { createdAt: true },
    _max: { createdAt: true }
  });

  // POS-CUST-015. Part-returned bills count for what was kept, as in statsFor.
  const back = await prisma.return.findMany({
    where: {
      clientId,
      originalSale: { customerId: { in: customerIds }, status: { in: ['COMPLETED', 'BALANCE_DUE'] } }
    },
    select: { totalPaise: true, originalSale: { select: { customerId: true } } }
  });
  const backBy = new Map<string, number>();
  for (const r of back) {
    const id = r.originalSale.customerId;
    if (id) backBy.set(id, (backBy.get(id) ?? 0) + r.totalPaise);
  }

  for (const row of grouped) {
    if (!row.customerId) continue;
    out.set(row.customerId, {
      count: row._count._all,
      total: (row._sum.totalPaise ?? 0) - (backBy.get(row.customerId) ?? 0),
      first: row._min.createdAt ?? null,
      last: row._max.createdAt ?? null
    });
  }
  return out;
}

function normalise(raw: string) {
  try {
    return normalisePhone(raw);
  } catch (error) {
    // The phone utility's messages are already written for a person; pass them straight through
    // rather than replacing them with something vaguer.
    throw badRequest(error instanceof PhoneError ? error.message : 'That does not look like a phone number.');
  }
}

/**
 * A customer's business details: name, GSTIN and address, for B2B tax invoices. PATCH-style -- a
 * field left out stays as it is; null clears it. A GSTIN is checked (format and check character),
 * and an address is asked for with it, because a tax invoice to a business must carry both.
 * Bills already issued keep the details they were issued with.
 */
export async function updateDetails(
  actor: Actor,
  customerId: string,
  input: { name?: string | null; gstin?: string | null; address?: string | null }
): Promise<CustomerCard> {
  const row = await prisma.customer.findFirst({ where: { id: customerId, clientId: actor.clientId, deletedAt: null }, select: SELECT });
  if (!row) throw notFound('That customer was not found.');
  const patch: Prisma.CustomerUpdateInput = {};
  if (input.name !== undefined) patch.name = input.name?.trim() || null;
  if (input.address !== undefined) patch.address = input.address?.trim() || null;
  if (input.gstin !== undefined) {
    const gstin = input.gstin?.trim() ? normaliseGstin(input.gstin) : null;
    if (gstin) { const problem = gstinProblem(gstin); if (problem) throw badRequest(problem, { code: 'BAD_GSTIN' }); }
    patch.gstin = gstin;
  }
  const gstinAfter = patch.gstin !== undefined ? patch.gstin : row.gstin;
  const addressAfter = patch.address !== undefined ? patch.address : row.address;
  if (gstinAfter && !addressAfter) {
    throw badRequest('Add the business address too -- a tax invoice to a GST-registered buyer shows their address.', { code: 'ADDRESS_REQUIRED' });
  }
  const updated = Object.keys(patch).length ? await prisma.customer.update({ where: { id: row.id }, data: patch, select: SELECT }) : row;
  if (Object.keys(patch).length) {
    await record(actor, { action: 'customer.updated', subject: maskPhone(row.phone), detail: { fields: Object.keys(patch), gstin: updated.gstin } });
  }
  return card(updated, await statsFor(actor.clientId, updated.id));
}
