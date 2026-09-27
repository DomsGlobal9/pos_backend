/**
 * Invoice and credit-note numbering. One job: the next number, unbroken, inside your transaction.
 */
export { nextNumber, financialYearOf } from './invoice-series.service';
export type { AllocatedNumber } from './invoice-series.service';
