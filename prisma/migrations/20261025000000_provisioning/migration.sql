-- Loan-loss provisioning (Feature 5): data model only.
-- CreateTable
CREATE TABLE "ProvisionRun" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "totalProvision" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProvisionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionEntry" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProvisionEntry_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Cooperative" ADD COLUMN "loanLossProvisionBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CooperativeConfig" ADD COLUMN "provisionRates" TEXT NOT NULL DEFAULT '{"1-30":1,"31-90":5,"91-180":20,"180+":50}';

-- CreateIndex
CREATE UNIQUE INDEX "ProvisionRun_cooperativeId_period_key" ON "ProvisionRun"("cooperativeId", "period");
CREATE INDEX "ProvisionRun_cooperativeId_createdAt_idx" ON "ProvisionRun"("cooperativeId", "createdAt");
CREATE INDEX "ProvisionEntry_runId_idx" ON "ProvisionEntry"("runId");
CREATE INDEX "ProvisionEntry_loanId_idx" ON "ProvisionEntry"("loanId");

-- AddForeignKey
ALTER TABLE "ProvisionRun" ADD CONSTRAINT "ProvisionRun_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProvisionEntry" ADD CONSTRAINT "ProvisionEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ProvisionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProvisionEntry" ADD CONSTRAINT "ProvisionEntry_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
