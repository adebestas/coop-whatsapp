-- A17: NIN-based member KYC. BVN is deliberately NOT collected.
--   kycStatus: unset | pending | verified | failed

-- AlterTable
ALTER TABLE "Member" ADD COLUMN "nin" TEXT,
ADD COLUMN "kycStatus" TEXT NOT NULL DEFAULT 'unset',
ADD COLUMN "kycVerifiedAt" TIMESTAMP(3);
