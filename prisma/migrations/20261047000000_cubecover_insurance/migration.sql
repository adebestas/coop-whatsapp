-- CubeCover insurance: policies and claims tables.
-- Mirrors the InsurancePolicy and InsuranceClaim models in schema.prisma.
CREATE TABLE "InsurancePolicy" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "productCode" TEXT NOT NULL,
  "planCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "cubecoverPolicyId" TEXT,
  "premiumKobo" INTEGER NOT NULL,
  "coverageKobo" INTEGER NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endDate" TIMESTAMP(3),
  "autoRenew" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InsurancePolicy_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InsurancePolicy_cooperativeId_memberId_idx" ON "InsurancePolicy"("cooperativeId", "memberId");
CREATE INDEX "InsurancePolicy_cooperativeId_status_idx" ON "InsurancePolicy"("cooperativeId", "status");
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InsuranceClaim" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "claimType" TEXT NOT NULL,
  "amountKobo" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "cubecoverClaimId" TEXT,
  "description" TEXT,
  "documents" JSONB,
  "payoutKobo" INTEGER,
  "payoutDestination" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "InsuranceClaim_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InsuranceClaim_cooperativeId_memberId_idx" ON "InsuranceClaim"("cooperativeId", "memberId");
CREATE INDEX "InsuranceClaim_cooperativeId_status_idx" ON "InsuranceClaim"("cooperativeId", "status");
CREATE INDEX "InsuranceClaim_policyId_idx" ON "InsuranceClaim"("policyId");
ALTER TABLE "InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "InsurancePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
