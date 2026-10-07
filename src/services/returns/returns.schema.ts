import { z } from 'zod';
import { completeSaleSchema } from '../sale/sale.schema';

/**
 * What the till may send for a return or an exchange.
 *
 * As with a sale, THERE IS NO AMOUNT IN HERE. The till says which lines of which bill and how many;
 * what each piece is worth is worked out on the server from what was actually paid for it on that
 * bill. A refund amount typed in a browser is a refund amount anyone with dev tools can change.
 */

const returnLine = z.object({
  saleLineId: z.string().min(1),
  qty: z.number().int().positive('Return at least one').max(9999)
});

const lines = z.array(returnLine)
  .min(1, 'Choose what is coming back')
  .max(100, 'That is more lines than a bill has');

/**
 * How the money goes back. POS-RET-007, POS-PAY-015.
 *
 * EXCHANGE is not offered here: an exchange is its own request, because it is a return AND a sale.
 */
export const refundSchema = z.object({
  method: z.enum(['CASH', 'UPI', 'CARD', 'STORE_CREDIT']),
  /** The UPI or card refund's reference. Required for those two, as on a payment. */
  reference: z.string().trim().max(64).optional()
});

const approval = z.object({
  pin: z.string().min(1),
  reason: z.string().trim().min(1)
}).optional();

/** POS-RET-003. A few words -- it is what the owner reads when returns start to climb. */
const reason = z.string().trim()
  .min(3, 'Say why it is coming back')
  .max(200);

export const quoteSchema = z.object({ lines });

export const createReturnSchema = z.object({
  /** One per return, made by the till. A double press or a retry records one credit note. */
  onceKey: z.string().min(8).max(100),
  lines,
  reason,
  refund: refundSchema,
  /**
   * Who store credit goes to, when the original bill had nobody on it. A walk-in who paid cash and
   * gave no number is still owed their credit -- they give the number now.
   */
  customerId: z.string().min(1).optional(),
  approval,
  /** Which till, so a cash refund comes out of that drawer. POS-SHIFT-005. */
  counterId: z.string().min(1).optional()
});

/**
 * An exchange: goods back, other goods out, only the difference settled. POS-EXC-001..005.
 *
 * The new bill is an ordinary sale in every rule, so it takes the sale's own fields. Its once-key
 * is derived from the exchange's, so the two can never be recorded apart.
 */
export const createExchangeSchema = z.object({
  onceKey: z.string().min(8).max(100),
  lines,
  reason,
  customerId: z.string().min(1).optional(),
  approval,
  newSale: completeSaleSchema.pick({
    counterId: true,
    lines: true,
    payments: true,
    billDiscountPaise: true,
    interState: true
  }),
  /**
   * Only when what came back is worth MORE than the new bill: how the rest goes back. Absent
   * otherwise -- the customer pays the difference through newSale.payments instead.
   */
  refund: refundSchema.optional()
});

export type QuoteInput = z.infer<typeof quoteSchema>;
export type CreateReturnInput = z.infer<typeof createReturnSchema>;
export type CreateExchangeInput = z.infer<typeof createExchangeSchema>;
export type RefundInput = z.infer<typeof refundSchema>;
