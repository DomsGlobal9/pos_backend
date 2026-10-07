-- A UPI or card reference already on another bill needs a manager (PLAN-payments Step 1).
-- Approved with payment:void, the permission that already settles payments being checked.
ALTER TYPE "ApprovalKind" ADD VALUE 'DUPLICATE_REFERENCE';
