import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { conflict, notFound } from '../../utils/httpError';
import { rupees } from '../money';

/**
 * Store credit. POS-CUST-012, POS-PAY-016.
 *
 * Money the shop owes a customer, held against their phone number, spent in the shop. A return
 * gives it; a sale spends it.
 *
 * THE RULE THAT MATTERS (CONTRACTS 1.1): the same Rs 2,000 of credit spent twice is the shop's own
 * money out of the door twice. So spending is ONE statement with the check inside it:
 *
 *     UPDATE customers SET balance = balance - x WHERE id = ? AND balance >= x
 *
 * Two tills spending the same credit at the same moment both send that. Postgres runs them one
 * after the other on the row; the second finds the balance already gone and updates nothing. A
 * read-then-write -- "is there enough? yes, so take it" -- lets both through, because both read
 * before either wrote. The database also holds a CHECK (balance >= 0) as the last line.
 *
 * Every change writes a ledger row in the same transaction, so "why is my credit Rs 340?" always
 * has an answer.
 */

type Tx = Prisma.TransactionClient;

interface Link {
  returnId?: string | null;
  saleId?: string | null;
}

/** Give credit. Used by a return refunded as store credit. Returns the new balance. */
export async function addCredit(
  tx: Tx,
  actor: Actor,
  customerId: string,
  amountPaise: number,
  link: Link
): Promise<number> {
  if (amountPaise <= 0) return currentBalance(tx, actor, customerId);

  const rows = await tx.$queryRaw<{ balance: number }[]>`
    UPDATE customers
       SET store_credit_paise = store_credit_paise + ${amountPaise}, updated_at = now()
     WHERE id = ${customerId} AND client_id = ${actor.clientId} AND deleted_at IS NULL
 RETURNING store_credit_paise AS balance`;
  if (rows.length === 0) throw notFound('That customer was not found.');

  const balance = Number(rows[0].balance);
  await tx.storeCreditEntry.create({
    data: {
      clientId: actor.clientId,
      customerId,
      amountPaise,
      balanceAfterPaise: balance,
      returnId: link.returnId ?? null,
      saleId: link.saleId ?? null,
      byId: actor.kind === 'USER' ? actor.id : null
    }
  });
  return balance;
}

/**
 * Spend credit. Refuses, with the real balance, rather than going below zero. Returns the new
 * balance.
 */
export async function spendCredit(
  tx: Tx,
  actor: Actor,
  customerId: string,
  amountPaise: number,
  link: Link
): Promise<number> {
  if (amountPaise <= 0) return currentBalance(tx, actor, customerId);

  const rows = await tx.$queryRaw<{ balance: number }[]>`
    UPDATE customers
       SET store_credit_paise = store_credit_paise - ${amountPaise}, updated_at = now()
     WHERE id = ${customerId} AND client_id = ${actor.clientId} AND deleted_at IS NULL
       AND store_credit_paise >= ${amountPaise}
 RETURNING store_credit_paise AS balance`;

  if (rows.length === 0) {
    const have = await currentBalance(tx, actor, customerId);
    throw conflict(
      have === 0
        ? 'This customer has no store credit left.'
        : `This customer has only ${rupees(have)} of store credit.`,
      { code: 'NOT_ENOUGH_CREDIT', availablePaise: have, wantedPaise: amountPaise }
    );
  }

  const balance = Number(rows[0].balance);
  await tx.storeCreditEntry.create({
    data: {
      clientId: actor.clientId,
      customerId,
      amountPaise: -amountPaise,
      balanceAfterPaise: balance,
      returnId: link.returnId ?? null,
      saleId: link.saleId ?? null,
      byId: actor.kind === 'USER' ? actor.id : null
    }
  });
  return balance;
}

async function currentBalance(db: Tx | typeof prisma, actor: Actor, customerId: string) {
  const row = await db.customer.findFirst({
    where: { id: customerId, clientId: actor.clientId, deletedAt: null },
    select: { storeCreditPaise: true }
  });
  if (!row) throw notFound('That customer was not found.');
  return row.storeCreditPaise;
}

export interface CreditEntry {
  id: string;
  amountPaise: number;
  balanceAfterPaise: number;
  createdAt: Date;
  /** What caused it, by the number on the paper: a credit note or an invoice. */
  documentNo: string | null;
  documentId: string | null;
  documentKind: 'CREDIT_NOTE' | 'INVOICE' | null;
}

/** The ledger, newest first. What the customer card shows under the balance. */
export async function history(actor: Actor, customerId: string, take = 20): Promise<CreditEntry[]> {
  const rows = await prisma.storeCreditEntry.findMany({
    where: { clientId: actor.clientId, customerId },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, amountPaise: true, balanceAfterPaise: true, createdAt: true, returnId: true, saleId: true }
  });

  const returnIds = rows.map(r => r.returnId).filter((x): x is string => !!x);
  const saleIds = rows.map(r => r.saleId).filter((x): x is string => !!x);
  const [returns, sales] = await Promise.all([
    returnIds.length
      ? prisma.return.findMany({ where: { id: { in: returnIds }, clientId: actor.clientId }, select: { id: true, creditNoteNo: true } })
      : [],
    saleIds.length
      ? prisma.sale.findMany({ where: { id: { in: saleIds }, clientId: actor.clientId }, select: { id: true, invoiceNo: true } })
      : []
  ]);
  const cn = new Map(returns.map(r => [r.id, r.creditNoteNo]));
  const inv = new Map(sales.map(s => [s.id, s.invoiceNo]));

  return rows.map(r => ({
    id: r.id,
    amountPaise: r.amountPaise,
    balanceAfterPaise: r.balanceAfterPaise,
    createdAt: r.createdAt,
    documentNo: r.returnId ? cn.get(r.returnId) ?? null : r.saleId ? inv.get(r.saleId) ?? null : null,
    documentId: r.returnId ?? r.saleId ?? null,
    documentKind: r.returnId ? 'CREDIT_NOTE' : r.saleId ? 'INVOICE' : null
  }));
}
