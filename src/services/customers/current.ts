import { Prisma } from '@prisma/client';

/**
 * A CUSTOMER JOINED INTO ANOTHER BY A CRM MERGE (19 Nov) is that other customer from then on: a number,
 * an old bill's link or a sale queued offline for the dropped one all land on the kept one. Followed a few
 * steps at most (a merge of a merge), never in a loop.
 */
export async function currentCustomerId(db: Pick<Prisma.TransactionClient, 'customer'>, clientId: string, id: string): Promise<string> {
  let at = id;
  for (let i = 0; i < 5; i++) {
    const c = await db.customer.findFirst({ where: { id: at, clientId }, select: { mergedIntoId: true } });
    if (!c?.mergedIntoId) return at;
    at = c.mergedIntoId;
  }
  return at;
}
