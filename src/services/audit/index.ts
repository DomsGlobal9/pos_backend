/**
 * Audit: who did what, append-only, and never able to fail a sale.
 */
export { record, recent } from './audit.service';
export type { AuditAction, AuditEntry, AuditRow } from './audit.service';
