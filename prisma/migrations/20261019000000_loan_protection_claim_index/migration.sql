-- A death claim can write off several outstanding protected loans (one
-- LoanProtection per loan), so the claim reference is no longer unique.
DROP INDEX "LoanProtection_claimId_key";
CREATE INDEX "LoanProtection_claimId_idx" ON "LoanProtection"("claimId");
