/**
 * Payments: the rules about money coming in.
 *
 * Shared by the counter (Phase 2), collecting a balance later (Phase 5) and refunds (Phase 6), so
 * the rules have one home rather than three drifting copies.
 */
export { planPayments, duplicateReferences, duplicateMessage, referenceFor, collectedPaise, owedPaise, refreshMoneyStatus, awaitingCheck, resolve, pretty } from './payments.service';
export type { PlannedPayment, UncheckedPayment, PaymentMode } from './payments.service';
