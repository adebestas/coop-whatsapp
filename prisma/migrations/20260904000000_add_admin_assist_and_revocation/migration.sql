-- AlterTable
ALTER TABLE "Member" ADD COLUMN "sessionsRevokedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AdminAssistAction" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetMemberId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "metadata" JSONB,
    "otp" TEXT NOT NULL,
    "otpExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    CONSTRAINT "AdminAssistAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAssistAction_cooperativeId_status_createdAt_idx" ON "AdminAssistAction"("cooperativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAssistAction_targetMemberId_status_idx" ON "AdminAssistAction"("targetMemberId", "status");

-- AddForeignKey
ALTER TABLE "AdminAssistAction" ADD CONSTRAINT "AdminAssistAction_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAssistAction" ADD CONSTRAINT "AdminAssistAction_targetMemberId_fkey" FOREIGN KEY ("targetMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAssistAction" ADD CONSTRAINT "AdminAssistAction_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
