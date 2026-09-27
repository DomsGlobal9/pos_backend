import { Prisma, SeriesKind } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Taking the next invoice or credit-note number.
 *
 * Its own service rather than a few lines inside the sale, because it has one job and one rule, and
 * the rule is the sort a tax officer asks about:
 *
 *     Unbroken, per financial year, per shop, never reused, never skipped, and allocated INSIDE the
 *     same transaction that saves the sale.
 *
 * A gap in the series is a question the shop has to answer. Inside the transaction means a sale
 * that fails takes its number back with it, so there is no gap; outside it, every failed attempt
 * would burn a number.
 *
 * Two tills pressing Complete in the same millisecond is the case this is written against. Read the
 * last number and then write it back, and both read 40 and both write 41. So the increment IS the
 * read -- one statement, and the database decides the order.
 */

/** Indian financial years run April to March, and a shop and its accountant say "2026-27". */
export function financialYearOf(date: Date): string {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1; // getMonth: 3 is April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export interface AllocatedNumber {
  number: string;
  financialYear: string;
  sequence: number;
}

/**
 * The next number in a series, allocated inside the caller's transaction.
 *
 * Creates the series row on first use so a new shop does not need seeding before it can sell. The
 * insert is ON CONFLICT DO NOTHING, so two first sales at once make one row rather than one of them
 * failing on the unique constraint.
 */
export async function nextNumber(
  tx: Tx,
  clientId: string,
  kind: SeriesKind,
  prefix: string,
  at: Date = new Date()
): Promise<AllocatedNumber> {
  const financialYear = financialYearOf(at);

  await tx.$executeRaw`
    INSERT INTO invoice_series (id, client_id, financial_year, kind, prefix, last_number, updated_at)
    VALUES (gen_random_uuid()::text, ${clientId}, ${financialYear}, ${kind}::"SeriesKind", ${prefix}, 0, NOW())
    ON CONFLICT (client_id, financial_year, kind) DO NOTHING`;

  /*
   * The increment and the read are one statement. This is the whole point of the file: two
   * concurrent sales serialise on this row's lock and come out 41 and 42, never 41 twice.
   */
  const rows = await tx.$queryRaw<{ last_number: number; prefix: string }[]>`
    UPDATE invoice_series
       SET last_number = last_number + 1, updated_at = NOW()
     WHERE client_id = ${clientId} AND financial_year = ${financialYear} AND kind = ${kind}::"SeriesKind"
    RETURNING last_number, prefix`;

  const row = rows[0];
  if (!row) {
    // Cannot happen: the insert above guarantees the row. If it ever does, failing loudly is far
    // better than inventing a number.
    throw new Error(`invoice series missing for ${clientId} ${financialYear} ${kind}`);
  }

  const sequence = Number(row.last_number);
  return {
    number: `${row.prefix}/${financialYear}/${String(sequence).padStart(4, '0')}`,
    financialYear,
    sequence
  };
}
