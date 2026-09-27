/**
 * Sale: completing a bill, and reading one back.
 *
 * One transaction -- the number, the bill, its lines and the money together or not at all -- and
 * idempotent on a once-key, so a double press, a retry and an outbox flush all end in one sale.
 */
export { completeSale, getSale } from './sale.service';
export { completeSaleSchema } from './sale.schema';
export type { CompleteSaleInput, SaleLineInput, PaymentInput } from './sale.schema';
