-- Bank transfer and cheque (10 Oct, agreed with Inventory: BANK_TRANSFER, CHEQUE). Both wait to be
-- checked, and reach Inventory only once arrived or cleared.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'BANK_TRANSFER';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CHEQUE';
