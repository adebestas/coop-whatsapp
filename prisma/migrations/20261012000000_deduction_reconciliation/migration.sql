-- =============================================================================
-- DeductionBatch: cheque + reconciliation lifecycle
-- =============================================================================
-- Adds the states and fields needed to track an employer remittance from
-- "cheque received" through "reconciled against the actual bank credit" before
-- members are credited.
-- =============================================================================

ALTER TABLE "DeductionBatch" ADD COLUMN "chequeRef" TEXT;
ALTER TABLE "DeductionBatch" ADD COLUMN "chequeAmount" INTEGER;
ALTER TABLE "DeductionBatch" ADD COLUMN "chequeReceivedAt" TIMESTAMP(3);
ALTER TABLE "DeductionBatch" ADD COLUMN "chequeReceivedById" TEXT;
ALTER TABLE "DeductionBatch" ADD COLUMN "reconciledAt" TIMESTAMP(3);
ALTER TABLE "DeductionBatch" ADD COLUMN "reconciledAmount" INTEGER;
ALTER TABLE "DeductionBatch" ADD COLUMN "reconciliationSource" TEXT;
ALTER TABLE "DeductionBatch" ADD COLUMN "reconciliationNote" TEXT;
