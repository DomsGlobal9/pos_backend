/**
 * Store credit: given by a return, spent at the till. Every spend is one guarded UPDATE, so the
 * same credit can never be spent twice. See CONTRACTS 1.1.
 */
export { addCredit, spendCredit, history } from './store-credit.service';
export type { CreditEntry } from './store-credit.service';
