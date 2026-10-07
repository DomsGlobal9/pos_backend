/**
 * Customers: who the person at the counter is, and what they have bought here.
 *
 * Standalone today -- this table is the master. When CRM arrives this folder becomes a cache in
 * front of it, the way `items` will become a cache in front of Inventory. Nothing outside here
 * knows where a customer came from, which is what makes that swap a change in one place.
 */
export { findByPhone, findOrCreate, search, detail, updateDetails } from './customers.service';
export type { CustomerCard, CustomerDetail } from './customers.service';
