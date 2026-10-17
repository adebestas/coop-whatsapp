CREATE TABLE "RefundRequest" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "mandateDebitId" TEXT,
  "amount" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "recommendedById" TEXT NOT NULL,
  "approvedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "payoutRef" TEXT,
  CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RefundRequest_cooperativeId_status_idx" ON "RefundRequest"("cooperativeId", "status");
CREATE INDEX "RefundRequest_cooperativeId_memberId_idx" ON "RefundRequest"("cooperativeId", "memberId");
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
