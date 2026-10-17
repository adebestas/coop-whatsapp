-- Platform Console: platform-scoped identity + policy + global audit tables, plus
-- Cooperative.tokensValidAfter and loan-term rules on CooperativeConfig.
-- Platform-level tables (no cooperativeId tenant scope, no RLS). Mirrors the
-- PlatformAdmin, PlatformPolicy and PlatformAuditLog models in schema.prisma.
CREATE TABLE "PlatformAdmin" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'developer',
  "pin" TEXT,
  "totpSecret" TEXT,
  "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "mustChangePin" BOOLEAN NOT NULL DEFAULT true,
  "tokensValidAfter" TIMESTAMP(3),
  "createdById" TEXT,
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformAdmin_phone_key" ON "PlatformAdmin"("phone");

CREATE TABLE "PlatformPolicy" (
  "key" TEXT NOT NULL,
  "value" TEXT,
  "min" DOUBLE PRECISION,
  "max" DOUBLE PRECISION,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformPolicy_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "PlatformAuditLog" (
  "id" TEXT NOT NULL,
  "actorId" TEXT,
  "actorPhone" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "cooperativeId" TEXT,
  "targetType" TEXT,
  "targetId" TEXT,
  "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlatformAuditLog_action_idx" ON "PlatformAuditLog"("action");
CREATE INDEX "PlatformAuditLog_cooperativeId_createdAt_idx" ON "PlatformAuditLog"("cooperativeId", "createdAt");

-- AlterTable
ALTER TABLE "Cooperative" ADD COLUMN "tokensValidAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CooperativeConfig" ADD COLUMN "loanDurationMonths" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN "minLoanTermMonths" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "maxLoanPerMember" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "minMembershipMonths" INTEGER NOT NULL DEFAULT 0;
