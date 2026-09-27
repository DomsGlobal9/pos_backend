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
  lineDiscountPaise: paise.nonnegative().optional()
});

export const paymentSchema = z.object({
  method: z.enum(['CASH', 'UPI', 'CARD']),
  amountPaise: paise.positive('A payment has to be for something'),
  /** Cash handed over. Only meaningful for CASH, and the change is worked out from it. */
  tenderedPaise: paise.positive().optional(),
  reference: z.string().trim().max(64).optional()
});

export const completeSaleSchema = z.object({
  /**
   * One key per basket, made by the till. This is what makes pressing Complete twice, a retry
   * after a timeout, and the offline outbox flushing the same bill all end in ONE sale.
   */
  onceKey: z.string().min(8).max(100),
  counterId: z.string().min(1, 'Which till is this?'),
  lines: z.array(saleLineSchema).min(1, 'There is nothing on this bill'),
  payments: z.array(paymentSchema).min(1, 'Nothing has been paid'),
  billDiscountPaise: paise.nonnegative().optional(),
  /** A bill to another state: one IGST figure rather than a CGST and SGST pair. */
  interState: z.boolean().optional(),
  /** Set by the till when the bill was made with no connection and is being flushed now. */
  madeOfflineAt: z.coerce.date().optional()
});

export type CompleteSaleInput = z.infer<typeof completeSaleSchema>;
export type SaleLineInput = z.infer<typeof saleLineSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
