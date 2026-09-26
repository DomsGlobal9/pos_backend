/**
 * Money, as integers.
 *
 * Every calculation here happens in PAISE, held in a plain JavaScript number. Nothing in this
 * service does arithmetic on a float rupee value.
 *
 * Why not floats: 0.1 + 0.2 is 0.30000000000000004. On one line nobody notices; across a forty-line
 * bill and a day of trading it is how a drawer stops balancing and a cashier stops trusting the
 * software.
 *
 * Why not Decimal: it is exact, but every operation allocates and the rounding mode has to be stated
 * at each call site -- which means eventually it is not. An integer count of paise cannot be rounded
 * by accident, because there is nothing below it to round to.
 *
 * A number holds integers exactly up to 2^53, about ninety thousand billion rupees in paise.
 *
 * The arithmetic here matches Inventory's `services/pricing/money.ts` deliberately, function for
 * function, because both will be pulled into the shared offers package later and two dialects of
 * rounding would mean a till and a website disagreeing by a paisa on the same basket. The only
 * difference: Inventory converts to and from Prisma Decimal columns, and the POS stores Int paise
 * natively, so there is nothing to convert.
 */

/** Anything a caller might hand us that is meant to be an amount of money in rupees. */
export type MoneyLike = number | string | null | undefined;

/** Rupees in, paise out. Exact for any value with at most two decimal places. */
export function toMinor(value: MoneyLike): number {
  if (value === null || value === undefined) return 0;
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return 0;
  return Math.round(asNumber * 100);
}

/** Paise in, a plain rupee number out -- for JSON responses and for anything shown to a person. */
export function fromMinor(minor: number): number {
  return minor / 100;
}

/** What a person reads: ₹1,20,450.50, in the Indian grouping a shop expects. */
export function rupees(minor: number): string {
  const negative = minor < 0;
  const value = Math.abs(minor) / 100;
  const text = value.toLocaleString('en-IN', {
    minimumFractionDigits: Math.abs(minor) % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  });
  return `${negative ? '-' : ''}₹${text}`;
}

/**
 * A percentage of an amount, rounded HALF-UP, computed entirely in integers.
 *
 * `percent` may carry two decimal places of its own (12.5%, 33.33%).
 *
 * The division is done by hand, comparing `remainder * 2 >= divisor` in integers, because that form
 * cannot round the wrong way at any magnitude.
 *
 * It is NOT here because the float form was caught misbehaving. Inventory's copy of this function
 * says `(minor * basis) / 10000` can land on 1234.4999999999998 and round down; verify-money went
 * looking for such an input across 21 million combinations of amount and rate and found none. The
 * two routes only diverge once `amount x rate` passes 2^53, which is past ₹50 billion on one line.
 *
 * Kept anyway, because a proof costs nothing here and a shop's arithmetic should not rest on the
 * magnitudes staying small. But written down honestly, so nobody inherits a bug story that has
 * never been reproduced.
 */
export function applyPercent(minor: number, percent: number): number {
  const basis = Math.round(percent * 100); // 20 -> 2000, 12.5 -> 1250
  const negative = minor < 0;
  const magnitude = Math.abs(minor) * basis;

  const quotient = Math.floor(magnitude / 10000);
  const remainder = magnitude - quotient * 10000;
  const rounded = remainder * 2 >= 10000 ? quotient + 1 : quotient;

  return negative ? -rounded : rounded;
}

/**
 * Split an amount across several lines so the parts add up to EXACTLY the whole.
 *
 * Largest-remainder method. The obvious implementation is wrong on the very first three-line bill:
 * ₹100 across three equal lines is 33.33 three times, which is ₹99.99, and a paisa has gone missing.
 *
 * Ties go to the earlier line, so the same input always gives the same output -- a bill re-priced
 * must not redistribute its own discount.
 */
export function allocate(totalMinor: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (totalMinor === 0) return weights.map(() => 0);

  const negative = totalMinor < 0;
  const total = Math.abs(totalMinor);

  const safeWeights = weights.map(w => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = safeWeights.reduce((a, b) => a + b, 0);

  // Nothing to weight by -- a basket of zero-priced items with a discount against it. Spread it
  // evenly rather than throw it away.
  if (weightSum === 0) {
    const base = Math.floor(total / weights.length);
    const shares = weights.map(() => base);
    let left = total - base * weights.length;
    for (let i = 0; left > 0; i++, left--) shares[i] += 1;
    return negative ? shares.map(s => -s) : shares;
  }

  const exact = safeWeights.map(w => (total * w) / weightSum);
  const shares = exact.map(v => Math.floor(v));
  let remaining = total - shares.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, index) => ({ index, fraction: v - Math.floor(v) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));

  for (let i = 0; remaining > 0; i = (i + 1) % order.length, remaining--) {
    shares[order[i].index] += 1;
  }

  return negative ? shares.map(s => -s) : shares;
}

/** A per-unit price derived from the line total, rounded half-up. The line total is the
 * authoritative number; this is for display. */
export function netUnitPrice(lineTotalMinor: number, quantity: number): number {
  if (quantity <= 0) return 0;
  const quotient = Math.floor(lineTotalMinor / quantity);
  const remainder = lineTotalMinor - quotient * quantity;
  return remainder * 2 >= quantity ? quotient + 1 : quotient;
}

// ---------------------------------------------------------------------------------------------
// GST
// ---------------------------------------------------------------------------------------------

export interface TaxSplit {
  /** The price before tax. */
  netMinor: number;
  /** The tax inside the shelf price. */
  taxMinor: number;
  /** Half the tax. Intra-state only -- zero on an inter-state bill. */
  cgstMinor: number;
  sgstMinor: number;
  /** The whole tax. Inter-state only -- zero on an intra-state bill. */
  igstMinor: number;
}

/**
 * Take the GST back OUT of a shelf price.
 *
 * SHELF PRICES INCLUDE GST. The price on the tag is the price paid -- that is settled, and carried
 * over from the counter sale that ran inside Inventory. But the invoice must still show the tax
 * split, because a GST invoice is not optional, so every line has to be worked backwards:
 *
 *     net = gross x 100 / (100 + rate)
 *     tax = gross - net
 *
 * `tax` is deliberately the SUBTRACTION rather than its own rounded calculation. Rounding both
 * independently lets them fail to add up to the gross, and then a bill whose lines are correct has
 * a total that is a paisa out -- the kind of fault a shop notices at the end of the day and cannot
 * explain. Taking the difference makes `net + tax === gross` true by construction, for every input.
 *
 * `interState` decides the shape of the split, not the amount. Within a state the same tax is
 * halved into CGST and SGST; across state lines it is one IGST line. An odd paisa goes to CGST, so
 * the halves still sum to the tax exactly.
 *
 * `ratePercent` is a number rather than an integer so that a rate with a half in it keeps working
 * if the column that feeds it ever widens. Clothing is 5% and 12%.
 */
export function splitInclusiveTax(grossMinor: number, ratePercent: number, interState = false): TaxSplit {
  if (!Number.isFinite(ratePercent) || ratePercent <= 0) {
    return { netMinor: grossMinor, taxMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
  }

  const negative = grossMinor < 0;
  const gross = Math.abs(grossMinor);

  // Integer half-up: net = gross * 10000 / (10000 + rateBasis), done without floats.
  const rateBasis = Math.round(ratePercent * 100);
  const divisor = 10000 + rateBasis;
  const magnitude = gross * 10000;
  const quotient = Math.floor(magnitude / divisor);
  const remainder = magnitude - quotient * divisor;
  const net = remainder * 2 >= divisor ? quotient + 1 : quotient;

  const tax = gross - net;

  // The odd paisa goes to CGST. Arbitrary, but fixed -- the same bill must split the same way every
  // time it is printed.
  const cgst = interState ? 0 : Math.ceil(tax / 2);
  const sgst = interState ? 0 : tax - cgst;

  const sign = (n: number) => (negative ? -n : n);
  return {
    netMinor: sign(net),
    taxMinor: sign(tax),
    cgstMinor: sign(cgst),
    sgstMinor: sign(sgst),
    igstMinor: sign(interState ? tax : 0)
  };
}

// ---------------------------------------------------------------------------------------------
// The round-off line
// ---------------------------------------------------------------------------------------------

export type RoundingRule = 'NONE' | 'NEAREST_RUPEE' | 'UP_RUPEE' | 'DOWN_RUPEE';

export interface Rounded {
  /** What the customer is actually asked for. */
  totalMinor: number;
  /** The adjustment, positive or negative. Shown as its own line on the bill, never hidden inside
   * another number -- a customer who adds the lines up must be able to find the difference. */
  roundOffMinor: number;
}

/**
 * Round a bill to whole rupees, and say by how much.
 *
 * Most Indian counters do not hand over coins below a rupee, so the bill is rounded and the
 * adjustment is printed. `totalMinor === original + roundOffMinor` always holds, which is what lets
 * the day book reconcile: the sum of what was charged and the sum of the round-offs together equal
 * the sum of the bills.
 */
export function roundBill(minor: number, rule: RoundingRule = 'NEAREST_RUPEE'): Rounded {
  if (rule === 'NONE') return { totalMinor: minor, roundOffMinor: 0 };

  const negative = minor < 0;
  const value = Math.abs(minor);
  const whole = Math.floor(value / 100) * 100;
  const paise = value - whole;

  let rounded: number;
  if (rule === 'UP_RUPEE') rounded = paise === 0 ? whole : whole + 100;
  else if (rule === 'DOWN_RUPEE') rounded = whole;
  else rounded = paise >= 50 ? whole + 100 : whole;

  const total = negative ? -rounded : rounded;
  return { totalMinor: total, roundOffMinor: total - minor };
}

/**
 * Change due, and the note breakdown a cashier hands over.
 *
 * Getting change wrong loses real money, so it is calculated here and shown large rather than done
 * in someone's head at a counter with a queue.
 */
export function changeDue(tenderedMinor: number, dueMinor: number): number {
  return Math.max(0, tenderedMinor - dueMinor);
}
