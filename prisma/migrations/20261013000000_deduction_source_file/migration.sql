-- =============================================================================
-- DeductionBatch: link the uploaded employer file for audit
-- =============================================================================

ALTER TABLE "DeductionBatch" ADD COLUMN "sourceFileKey" TEXT;
ALTER TABLE "DeductionBatch" ADD COLUMN "sourceFileName" TEXT;
