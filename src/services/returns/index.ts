/**
 * Returns and exchanges: a credit note against one bill, in its own number series, and for an
 * exchange a new bill paid first by what came back. Nothing is ever deleted -- a wrong bill is
 * corrected by a credit note beside it. See returns.service for the rules.
 */
export { eligibility, quote, createReturn, createExchange, getReturn, shareOf, windowFor, approvalNeeded } from './returns.service';
export { quoteSchema, createReturnSchema, createExchangeSchema } from './returns.schema';
export type { CreateReturnInput, CreateExchangeInput, QuoteInput } from './returns.schema';
