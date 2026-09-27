/**
 * Approvals: a manager saying yes, in place, without the cashier logging out.
 */
export { grant, attachToSale, setPin, REASON_MIN, __resetLockouts } from './approvals.service';
export type { ApprovalRequest, GrantedApproval } from './approvals.service';
