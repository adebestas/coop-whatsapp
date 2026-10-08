CREATE TABLE "Referral" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "referrerId" TEXT NOT NULL,
  "referredMemberId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "qualifiedAt" TIMESTAMP(3),
  "rewardType" TEXT,
  "rewardAmount" INTEGER,
  "rewardedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Referral_referredMemberId_key" ON "Referral"("referredMemberId");
CREATE INDEX "Referral_cooperativeId_referrerId_idx" ON "Referral"("cooperativeId", "referrerId");
CREATE INDEX "Referral_cooperativeId_status_idx" ON "Referral"("cooperativeId", "status");
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredMemberId_fkey" FOREIGN KEY ("referredMemberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CooperativeConfig" ADD COLUMN "referralEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CooperativeConfig" ADD COLUMN "referralRewardType" TEXT NOT NULL DEFAULT 'wallet';
ALTER TABLE "CooperativeConfig" ADD COLUMN "referralRewardAmount" INTEGER NOT NULL DEFAULT 50000;
ALTER TABLE "CooperativeConfig" ADD COLUMN "referralMaxRewards" INTEGER NOT NULL DEFAULT 0;
