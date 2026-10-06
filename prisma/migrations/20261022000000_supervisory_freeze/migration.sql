-- Supervisory Committee freeze is a distinct state from the member's own
-- self-freeze: only the Supervisory Committee (or a super admin) can lift it,
-- and the member's `unfreeze` command must not clear it.
ALTER TABLE "Member" ADD COLUMN "supervisoryFrozenAt" TIMESTAMP(3);
