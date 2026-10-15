-- =============================================================================
-- RLS policies for tables that were missed (Stage 1: ENABLE, not FORCE)
-- =============================================================================
-- These tables carry `cooperativeId` (or are reached through a tenant parent)
-- but had no policy, so they stayed fully cross-tenant even after the RLS
-- cutover. Same semantics as 20261005000000_rls_policies:
--   * ENABLE (without FORCE) -> the table owner bypasses; a non-owner role is
--     restricted. Enforcement is opt-in per connection (see prisma/rls/).
--   * app.current_coop_id() returns NULL when the GUC is unset -> deny.
--
-- NOTE: the Federation* tables (FederationMembership/FederationPosting/
-- FederationLoan) are deliberately PLATFORM-LEVEL (no RLS) — the federation is
-- a cross-tenant entity by design (see docs/superpowers/specs/2026-10-15-federation-design.md).
-- =============================================================================

BEGIN;

-- Directly cooperativeId-scoped tables that were missed.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'InsurancePolicy','InsuranceClaim','LiteracyCertificate','OmbudsmanCase','PhoneChangeRequest'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("cooperativeId" = app.current_coop_id()) WITH CHECK ("cooperativeId" = app.current_coop_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- Child tables reached through a tenant parent (verified FK columns).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('DividendVoteBallot', 'voteId',       'DividendVote'),
      ('DeathClaimApproval', 'deathClaimId', 'DeathClaim'),
      ('GuarantorVerification', 'loanId',    'Loan'),
      ('DeductionWaiver',    'memberId',     'Member'),
      ('DataConsent',        'memberId',     'Member')
    ) AS v(child, fk, parent)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id())) WITH CHECK (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id()))',
      r.child || '_tenant_isolation', r.child,
      r.parent, r.child, r.fk,
      r.parent, r.child, r.fk
    );
  END LOOP;
END $$;

COMMIT;
