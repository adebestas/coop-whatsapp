-- Phone ownership proof for dashboard accounts (Phase 4).
--
-- PlatformAdmin gains phoneVerified so an operator whose channel number has
-- not answered an OTP cannot receive a magic link. PhoneOtp stores the
-- scrypt-hashed code, attempt count and single-use window.

ALTER TABLE "PlatformAdmin" ADD COLUMN "phoneVerified" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PhoneOtp" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneOtp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PhoneOtp_subjectType_subjectId_createdAt_idx" ON "PhoneOtp"("subjectType", "subjectId", "createdAt");

CREATE INDEX "PhoneOtp_expiresAt_idx" ON "PhoneOtp"("expiresAt");
