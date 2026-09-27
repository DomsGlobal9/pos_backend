import { z } from 'zod';

/**
 * What the till may send, and what it may not.
 *
 * The important absence: THERE IS NO PRICE IN HERE. The browser sends item ids and quantities. The
 * sale re-reads every price from the database inside its own transaction. A till that accepts a
 * price from its own client is a till where anyone who can open dev tools sells a silk saree for a
 * rupee, and no amount of care elsewhere fixes that.
 *
 * Money is in paise, as integers, everywhere. A schema that accepted rupees would have to decide
 * what to do with a third decimal place, and the answer it picked would be silent.
 */

const paise = z.number().int('Amounts are in paise, as whole numbers');

export const saleLineSchema = z.object({
  itemId: z.string().min(1),
  qty: z.number().int().positive('A line needs at least one of something'),
  lineDiscountPaise: paise.nonnegative().optional(),
  /**
   * SELLING AT A PRICE OTHER THAN THE TAG. POS-SELL-017.
   *
   * This is the one field that lets a price come from the browser, and it is the most abused
   * feature in any POS -- which is why it needs a permission, a reason, AND a manager's approval,
   * and why the tag price is stored beside it so a margin report can show what was given away.
   *
   * Without it, everything is still priced from the database.
   */
  overridePricePaise: paise.positive().optional()
});

export const paymentSchema = z.object({
  method: z.enum(['CASH', 'UPI', 'CARD']),
  amountPaise: paise.positive('A payment has to be for something'),
  /** Cash handed over. Only meaningful for CASH, and the change is worked out from it. */
  tenderedPaise: paise.positive().optional(),
  reference: z.string().trim().max(64).optional(),
  /**
   * The cashier is not sure this one arrived. POS-PAY-010.
   *
   * Set when a UPI transfer has not shown up on the shop's phone yet. The sale still completes --
   * the customer is walking out with the goods either way -- and the payment is recorded as
   * NEEDS_CHECKING for someone to settle against the bank. The alternative is asking the customer
   * to pay again, which is the one thing a till must never do.
   */
  unconfirmed: z.boolean().optional()
});

export const completeSaleSchema = z.object({
  /**
   * One key per basket, made by the till. This is what makes pressing Complete twice, a retry
   * after a timeout, and the offline outbox flushing the same bill all end in ONE sale.
   */
  onceKey: z.string().min(8).max(100),
  counterId: z.string().min(1, 'Which till is this?'),
  lines: z.array(saleLineSchema).min(1, 'There is nothing on this bill'),
  /** One row per method. POS-PAY-007/008: a split is simply more than one. */
  payments: z.array(paymentSchema).min(1, 'Nothing has been paid').max(6, 'That is too many separate payments for one bill'),
  /**
   * POS-CUST-001 and POS-SELL-018. Optional, and it must stay that way.
   *
   * Someone paying cash who will not give a number is a normal Saturday. Nothing in this path may
   * require a customer, which is why this is `.optional()` and not a nullable-with-default.
   */
  customerId: z.string().min(1).optional(),
  billDiscountPaise: paise.nonnegative().optional(),
  /**
   * A manager's yes, typed at the till. POS-APR-001.
   *
   * Sent WITH the sale rather than exchanged for a token first: a token that outlives the request
   * is a token that can be reused on a different basket, and the whole point of an approval is
   * that it authorised one specific thing.
   */
  approval: z.object({
    pin: z.string().min(1),
    reason: z.string().trim().min(1)
  }).optional(),
  /** A bill to another state: one IGST figure rather than a CGST and SGST pair. */
  interState: z.boolean().optional(),
  /** Set by the till when the bill was made with no connection and is being flushed now. */
  madeOfflineAt: z.coerce.date().optional()
});

export type CompleteSaleInput = z.infer<typeof completeSaleSchema>;
export type SaleLineInput = z.infer<typeof saleLineSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
