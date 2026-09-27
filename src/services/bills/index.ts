/**
 * Bills: finding a sale that has already been made, and marking reprints.
 *
 * Reading one bill in full stays in services/sale (getSale) -- a receipt is the sale's own shape,
 * and two services rendering the same bill differently is how a reprint stops matching the
 * original. This folder is search, filter and print history.
 */
export { list, recordPrint } from './bills.service';
export type { BillFilters, BillRow, BillPage } from './bills.service';
