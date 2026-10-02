-- AlterTable
ALTER TABLE "Member" DROP COLUMN "tier";

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "accountOfficerApprovedAt" TIMESTAMP(3),
ADD COLUMN     "accountOfficerApprovedById" TEXT;

-- AlterTable
ALTER TABLE "LedgerEntry" DROP COLUMN "status";

-- CreateTable
CREATE TABLE "AccountOfficer" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountOfficer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountOfficerAssignment" (
    "id" TEXT NOT NULL,
    "accountOfficerId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AccountOfficerAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuarantorVerification" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "guarantorId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuarantorVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountOfficer_email_key" ON "AccountOfficer"("email");

-- CreateIndex
CREATE INDEX "AccountOfficerAssignment_accountOfficerId_idx" ON "AccountOfficerAssignment"("accountOfficerId");

-- CreateIndex
CREATE INDEX "AccountOfficerAssignment_cooperativeId_idx" ON "AccountOfficerAssignment"("cooperativeId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountOfficerAssignment_accountOfficerId_cooperativeId_key" ON "AccountOfficerAssignment"("accountOfficerId", "cooperativeId");

-- CreateIndex
CREATE INDEX "GuarantorVerification_loanId_idx" ON "GuarantorVerification"("loanId");

-- CreateIndex
CREATE INDEX "GuarantorVerification_guarantorId_idx" ON "GuarantorVerification"("guarantorId");

-- CreateIndex
CREATE UNIQUE INDEX "GuarantorVerification_loanId_guarantorId_key" ON "GuarantorVerification"("loanId", "guarantorId");

-- CreateIndex
CREATE INDEX "Member_cooperativeId_status_role_idx" ON "Member"("cooperativeId", "status", "role");

-- CreateIndex
CREATE INDEX "Contribution_cooperativeId_status_createdAt_idx" ON "Contribution"("cooperativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Loan_cooperativeId_status_queuePosition_idx" ON "Loan"("cooperativeId", "status", "queuePosition");

-- CreateIndex
CREATE INDEX "Loan_accountOfficerApprovedById_idx" ON "Loan"("accountOfficerApprovedById");

-- CreateIndex
CREATE INDEX "Payout_cooperativeId_status_createdAt_idx" ON "Payout"("cooperativeId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "AccountOfficerAssignment" ADD CONSTRAINT "AccountOfficerAssignment_accountOfficerId_fkey" FOREIGN KEY ("accountOfficerId") REFERENCES "AccountOfficer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountOfficerAssignment" ADD CONSTRAINT "AccountOfficerAssignment_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuarantorVerification" ADD CONSTRAINT "GuarantorVerification_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuarantorVerification" ADD CONSTRAINT "GuarantorVerification_guarantorId_fkey" FOREIGN KEY ("guarantorId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
