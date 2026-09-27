import { allocate, applyPercent, roundBill, splitInclusiveTax, RoundingRule } from '../money';

/**
 * What a basket comes to.
 *
 * Pure: no database, no clock, no randomness. Everything it needs is handed to it, and the same
 * basket always prices to the same answer.
 *
 * That is not tidiness. The sell screen re-prices on every keystroke against a 150 ms budget, so
 * this cannot be a round trip; the offline outbox has to price a bill with no server at all; and
 * when the shared offers package arrives (step 5) it slots in here, beside this, rather than
 * replacing it. A pricing function that reads the database can do none of those things.
 *
 * WHERE THE PRICES COME FROM is the caller's problem, and there is one rule about it that matters:
 * they come from the database, never from the browser. A till that accepts a price from its own
 * client is a till where anyone who can open dev tools can sell a silk saree for one rupee.
 */

export interface BasketLine {
  /** Whatever the caller uses to tie this back to a row. Passed through untouched. */
  ref: string;
  description: string;
  hsn?: string | null;
  qty: number;
  /** GST-INCLUSIVE, in paise. The price on the tag. */
  unitPricePaise: number;
  /** Percent. 5 and 12 are the clothing rates. */
  taxRate: number;
  /** Money off this line, in paise, before tax is worked out. Manual, reasoned, permission-gated
   * upstream -- this just applies it. */
  lineDiscountPaise?: number;
}

export interface PricedLine {
  ref: string;
  description: string;
  hsn: string | null;
  qty: number;
  unitPricePaise: number;
  taxRate: number;
  /** This line's own discount plus its share of any bill-level discount. */
  discountPaise: number;
  /** What the customer pays for this line, after discount. GST-inclusive. */
  lineTotalPaise: number;
  /** The tax inside lineTotalPaise, and how it splits. */
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** lineTotalPaise minus taxPaise. On the invoice as the taxable value. */
  netPaise: number;
}

export interface PricedBasket {
  lines: PricedLine[];
  /** Before any discount, GST-inclusive. What the tags add up to. */
  subtotalPaise: number;
  /** Everything taken off, line and bill together. */
  discountPaise: number;
  /** The tax inside the bill. */
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** The rounding adjustment, its own line on the bill. */
  roundOffPaise: number;
  /** What the customer is asked for. */
  totalPaise: number;
  /** What they saved. Shown on the receipt, because it is the cheapest loyalty tool there is. */
  savedPaise: number;
}

export interface PriceBasketOptions {
  /** Money off the whole bill, in paise. Spread across the lines by value. */
  billDiscountPaise?: number;
  /** A percentage off the whole bill instead. Applied to the post-line-discount subtotal. */
  billDiscountPercent?: number;
  /** Across a state line the tax is one IGST figure rather than a CGST/SGST pair. */
  interState?: boolean;
  rounding?: RoundingRule;
}

/**
 * Price a basket.
 *
 * The order of operations matters and is fixed:
 *
 *   1. gross per line     = unit price x quantity        (tags, GST-inclusive)
 *   2. line discounts come off
 *   3. a bill discount is spread across the lines BY VALUE, using largest-remainder so the parts
 *      add back up to the discount exactly
 *   4. tax is taken back OUT of each line's final, discounted, GST-inclusive figure
 *   5. the bill is rounded, and the adjustment is its own line
 *
 * Step 3 is the one worth being careful about. A bill discount has to land on the lines rather than
 * being subtracted at the end, because the tax split is per line and an untaxed discount would make
 * the CGST on the invoice wrong. Spreading it by value is also what a customer expects when they
 * return one item out of three.
 *
 * Step 4 is why the tax is worked backwards at all: shelf prices include GST, and the invoice must
 * still show the split. See money.splitInclusiveTax for why the tax is a subtraction.
 */
export function priceBasket(lines: BasketLine[], options: PriceBasketOptions = {}): PricedBasket {
  const interState = options.interState ?? false;
  const rounding = options.rounding ?? 'NEAREST_RUPEE';

  // 1 and 2.
  const gross = lines.map(l => l.unitPricePaise * l.qty);
  const lineDiscounts = lines.map(l => Math.max(0, l.lineDiscountPaise ?? 0));
  const afterLine = gross.map((g, i) => Math.max(0, g - lineDiscounts[i]));

  const subtotalPaise = gross.reduce((a, b) => a + b, 0);
  const afterLineTotal = afterLine.reduce((a, b) => a + b, 0);

  // 3. A percentage is resolved against what is left after line discounts, so the two stack the
  // way a cashier expects rather than compounding on the original tags.
  let billDiscount = Math.max(0, options.billDiscountPaise ?? 0);
  if (options.billDiscountPercent) {
    billDiscount += applyPercent(afterLineTotal, options.billDiscountPercent);
  }
  // Never take off more than there is. A discount larger than the bill is a typo, and a negative
  // bill is not a thing a till can hand anyone.
  billDiscount = Math.min(billDiscount, afterLineTotal);

  const spread = allocate(billDiscount, afterLine);
  const finalLine = afterLine.map((v, i) => Math.max(0, v - spread[i]));

  // 4.
  const priced: PricedLine[] = lines.map((line, i) => {
    const split = splitInclusiveTax(finalLine[i], line.taxRate, interState);
    return {
      ref: line.ref,
      description: line.description,
      hsn: line.hsn ?? null,
      qty: line.qty,
      unitPricePaise: line.unitPricePaise,
      taxRate: line.taxRate,
      discountPaise: lineDiscounts[i] + spread[i],
      lineTotalPaise: finalLine[i],
      taxPaise: split.taxMinor,
      cgstPaise: split.cgstMinor,
      sgstPaise: split.sgstMinor,
      igstPaise: split.igstMinor,
      netPaise: split.netMinor
    };
  });

  const billBeforeRounding = finalLine.reduce((a, b) => a + b, 0);
  const rounded = roundBill(billBeforeRounding, rounding);
  const totalPaise = rounded.totalMinor;
  const roundOffPaise = rounded.roundOffMinor;

  const sum = (pick: (l: PricedLine) => number) => priced.reduce((a, l) => a + pick(l), 0);

  return {
    lines: priced,
    subtotalPaise,
    discountPaise: subtotalPaise - billBeforeRounding,
    taxPaise: sum(l => l.taxPaise),
    cgstPaise: sum(l => l.cgstPaise),
    sgstPaise: sum(l => l.sgstPaise),
    igstPaise: sum(l => l.igstPaise),
    roundOffPaise,
    totalPaise,
    // The round-off is not a saving, so it is excluded deliberately: a bill rounded DOWN by 45
    // paise would otherwise print "you saved 45 paise", which is not something to boast about.
    savedPaise: subtotalPaise - billBeforeRounding
  };
}
