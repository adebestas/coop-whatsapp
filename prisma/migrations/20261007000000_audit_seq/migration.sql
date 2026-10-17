-- =============================================================================
-- AuditLog: per-cooperative monotonic sequence
-- =============================================================================
-- The hash chain was ordered by createdAt, which collides at millisecond
-- precision — so "the last entry" (and chain verification) was ambiguous, and
-- concurrent writes could fork the chain. `seq` gives a deterministic order.
-- =============================================================================

ALTER TABLE "AuditLog" ADD COLUMN "seq" INTEGER;

-- Backfill existing rows in their current chain order.
UPDATE "AuditLog" a
SET "seq" = sub.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY "cooperativeId" ORDER BY "createdAt", id)::integer AS rn
  FROM "AuditLog"
) sub
WHERE a.id = sub.id;

ALTER TABLE "AuditLog" ALTER COLUMN "seq" SET NOT NULL;

CREATE UNIQUE INDEX "AuditLog_cooperativeId_seq_key" ON "AuditLog"("cooperativeId", "seq");
