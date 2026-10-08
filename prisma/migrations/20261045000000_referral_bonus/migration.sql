ALTER TABLE "Member" ADD COLUMN "referralBonusBalance" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ReferralWithdrawal" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "destination" TEXT NOT NULL,
  "phone" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "providerRef" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "ReferralWithdrawal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReferralWithdrawal_cooperativeId_memberId_idx" ON "ReferralWithdrawal"("cooperativeId", "memberId");
CREATE INDEX "ReferralWithdrawal_cooperativeId_status_idx" ON "ReferralWithdrawal"("cooperativeId", "status");
ALTER TABLE "ReferralWithdrawal" ADD CONSTRAINT "ReferralWithdrawal_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralWithdrawal" ADD CONSTRAINT "ReferralWithdrawal_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
