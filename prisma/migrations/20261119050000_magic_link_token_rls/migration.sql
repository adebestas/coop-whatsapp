-- Row-Level Security for MagicLinkToken (Stage 1: ENABLE, not FORCE).
--
-- The table landed in 20261119000000_auth_lockout_magic_links without a policy,
-- which the CI isolation suite catches. cooperativeId is nullable because
-- platform-admin links are platform-level; under a tenant GUC those rows are
-- simply invisible, exactly like the other platform tables that the owner role
-- reads by bypassing RLS. Tenant-scoped links get the standard policy.

BEGIN;

ALTER TABLE "MagicLinkToken" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "MagicLinkToken_tenant_isolation" ON "MagicLinkToken"
  USING ("cooperativeId" = app.current_coop_id())
  WITH CHECK ("cooperativeId" = app.current_coop_id());

COMMIT;
