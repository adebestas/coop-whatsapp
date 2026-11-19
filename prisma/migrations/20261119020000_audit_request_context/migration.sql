-- Audit entries gain the request's network context. These columns are NOT part
-- of the hash payload: legacy rows would otherwise fail verification, and the
-- chain's job is to prove the action fields were not edited, not to bind the IP.

ALTER TABLE "AuditLog" ADD COLUMN "ip" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "errorId" TEXT;

ALTER TABLE "PlatformAuditLog" ADD COLUMN "ip" TEXT;
ALTER TABLE "PlatformAuditLog" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "PlatformAuditLog" ADD COLUMN "errorId" TEXT;
