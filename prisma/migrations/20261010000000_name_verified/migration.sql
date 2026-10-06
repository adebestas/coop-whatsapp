-- =============================================================================
-- Member.nameVerified: maker-checker gate for deduction batches
-- =============================================================================
-- A deduction batch may only be approved once its creator's name has been
-- confirmed by a super admin. Existing members default to false; the founder
-- super admin is marked verified at onboarding.
-- =============================================================================

ALTER TABLE "Member" ADD COLUMN "nameVerified" BOOLEAN NOT NULL DEFAULT false;
