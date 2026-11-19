-- Auth hardening: durable login lockout ledger + single-use magic links.
--
-- LoginAttempt is append-only (never rewritten to clear a lock); LoginLock is
-- the small mutable counter the lockout maths reads. MagicLinkToken stores
-- only sha256(token) so a database leak cannot be replayed.
--
-- PlatformAdmin.email is nullable: existing operator accounts have no address
-- until one is verified, and the UNIQUE index tolerates NULLs.

ALTER TABLE "Member" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "PlatformAdmin" ADD COLUMN "email" TEXT;
ALTER TABLE "PlatformAdmin" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "PlatformAdmin_email_key" ON "PlatformAdmin"("email");

CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "memberId" TEXT,
    "phone" TEXT,
    "ip" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoginLock" (
    "id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "strikes" INTEGER NOT NULL DEFAULT 0,
    "lockCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastStrikeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginLock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MagicLinkToken" (
    "id" TEXT NOT NULL,
    "memberId" TEXT,
    "platformAdminId" TEXT,
    "cooperativeId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'dashboard_login',
    "requestedIp" TEXT NOT NULL,
    "requestUaHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginAttempt_surface_phone_createdAt_idx" ON "LoginAttempt"("surface", "phone", "createdAt");
CREATE INDEX "LoginAttempt_surface_ip_createdAt_idx" ON "LoginAttempt"("surface", "ip", "createdAt");
CREATE INDEX "LoginAttempt_createdAt_idx" ON "LoginAttempt"("createdAt");

CREATE UNIQUE INDEX "LoginLock_surface_subject_key" ON "LoginLock"("surface", "subject");
CREATE INDEX "LoginLock_lockedUntil_idx" ON "LoginLock"("lockedUntil");

CREATE UNIQUE INDEX "MagicLinkToken_tokenHash_key" ON "MagicLinkToken"("tokenHash");
CREATE INDEX "MagicLinkToken_memberId_createdAt_idx" ON "MagicLinkToken"("memberId", "createdAt");
CREATE INDEX "MagicLinkToken_platformAdminId_createdAt_idx" ON "MagicLinkToken"("platformAdminId", "createdAt");
CREATE INDEX "MagicLinkToken_expiresAt_idx" ON "MagicLinkToken"("expiresAt");

ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_platformAdminId_fkey"
    FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
