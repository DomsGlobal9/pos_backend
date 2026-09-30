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

/**
 * The digits to look for in a phone number -- or null when what was typed is not a phone number.
 *
 * Only a search made of digits (with spaces, +, - or brackets) is a phone search. The first version
 * pulled the digits out of ANY search, so "Kavya 2" also listed every customer whose number has a 2
 * in it -- found by a test searching for a name that does not exist. Three digits at least, so a
 * stray "9" does not list the whole shop.
 */
export function phoneDigits(text: string): string | null {
  if (!/^[\d\s+()-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 3 ? digits : null;
}
