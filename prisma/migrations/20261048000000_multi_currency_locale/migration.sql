-- =============================================================================
-- Multi-currency + multi-language: Cooperative.locale + Member.locale
-- =============================================================================
-- Cooperative.locale is the coop's default member language; Member.locale is
-- the member's own preference (NULL = inherit the coop default / auto-detect).
-- =============================================================================

ALTER TABLE "Cooperative" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "Member" ADD COLUMN "locale" TEXT;
