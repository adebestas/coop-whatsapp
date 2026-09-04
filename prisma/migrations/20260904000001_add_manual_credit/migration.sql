-- CreateTable
CREATE TABLE "ManualCredit" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "narration" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedById" TEXT,
    "rejectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),

    CONSTRAINT "ManualCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualCredit_cooperativeId_status_createdAt_idx" ON "ManualCredit"("cooperativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ManualCredit_memberId_status_idx" ON "ManualCredit"("memberId", "status");

-- AddForeignKey
ALTER TABLE "ManualCredit" ADD CONSTRAINT "ManualCredit_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCredit" ADD CONSTRAINT "ManualCredit_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCredit" ADD CONSTRAINT "ManualCredit_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCredit" ADD CONSTRAINT "ManualCredit_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCredit" ADD CONSTRAINT "ManualCredit_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
