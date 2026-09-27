/**
 * Escaping text that is about to go into a LIKE or ILIKE pattern.
 *
 * Prisma's `contains` and `equals` with mode: 'insensitive' both compile to ILIKE, where percent
 * and underscore are wildcards. So a cashier typing a bare percent sign matched EVERY item in the
 * shop, and an underscore matched any single character. That was a real bug in Inventory, found
 * and fixed once already -- it is escaped here from the first commit rather than after someone
 * reports that search is behaving strangely.
 *
 * The backslash is escaped first, or escaping the wildcards would then double-escape it.
 */
export function literal(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
