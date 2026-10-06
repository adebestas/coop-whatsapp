-- CreateTable
CREATE TABLE "LoanProtection" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "premium" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "claimId" TEXT,
    "writtenOff" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    CONSTRAINT "LoanProtection_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Cooperative" ADD COLUMN "protectionFundBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CooperativeConfig" ADD COLUMN "loanProtectionPercent" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "loanProtectionEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "LoanProtection_loanId_key" ON "LoanProtection"("loanId");
CREATE UNIQUE INDEX "LoanProtection_claimId_key" ON "LoanProtection"("claimId");
CREATE INDEX "LoanProtection_cooperativeId_status_idx" ON "LoanProtection"("cooperativeId", "status");
CREATE INDEX "LoanProtection_memberId_idx" ON "LoanProtection"("memberId");

-- AddForeignKey
ALTER TABLE "LoanProtection" ADD CONSTRAINT "LoanProtection_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LoanProtection" ADD CONSTRAINT "LoanProtection_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LoanProtection" ADD CONSTRAINT "LoanProtection_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LoanProtection" ADD CONSTRAINT "LoanProtection_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "DeathClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
