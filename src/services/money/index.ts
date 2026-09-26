/**
 * Money: integers, percentages, GST and the round-off line.
 *
 * Callers import this folder, never the files inside it.
 *
 * Nothing in here touches the database or the clock, which is deliberate: every later step reprices
 * a basket on every keystroke against a 150 ms budget, and this is the arithmetic underneath that.
 * It is also the part that will be pulled into the shared offers package, so Inventory, the till and
 * a merchant's own website all round a paisa the same way.
 */
export {
  toMinor,
  fromMinor,
  rupees,
  applyPercent,
  allocate,
  netUnitPrice,
  splitInclusiveTax,
  roundBill,
  changeDue
} from './money.service';

export type { MoneyLike, TaxSplit, RoundingRule, Rounded } from './money.service';
