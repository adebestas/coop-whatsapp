-- =============================================================================
-- Row-Level Security policies — Stage 2 (FORCE) — DRAFT, NOT APPLIED
-- =============================================================================
-- Stage 1 lives in prisma/migrations/20261005000000_rls_policies/migration.sql
-- and only ENABLEs RLS, so the table owner (the app's current DATABASE_URL)
-- bypasses it — zero behaviour change. This file is the follow-up that adds
-- FORCE, which removes the owner bypass and makes the policies bite for every
-- role, including the owner.
--
-- Do NOT apply this until every tenant query is routed through
-- src/lib/tenant-context.ts (setCoopContext / withCoopContext) so the
-- `app.current_cooperative_id` GUC is set inside the same transaction. With
-- FORCE on and the GUC unset, app.current_coop_id() returns NULL, every
-- comparison is NULL, and every tenant query returns zero rows (fail-closed).
--
-- Table lists below are the verified lists from the Stage 1 migration
-- (checked against information_schema on a fresh Postgres 16).
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_coop_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_cooperative_id', true), '');
$$;

-- Cooperative is keyed by its own id (it has no cooperativeId column).
ALTER TABLE "Cooperative" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Cooperative" FORCE ROW LEVEL SECURITY;
CREATE POLICY cooperative_tenant_isolation ON "Cooperative"
  USING (id = app.current_coop_id())
  WITH CHECK (id = app.current_coop_id());

-- Directly cooperativeId-scoped tables (verified list).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'AccountOfficerAssignment','AdminAssistAction','AuditLog','Beneficiary',
    'BrandingConfig','Broadcast','Byelaw','Contribution','CoopPost',
    'CooperativeConfig','DeathClaim','DeductionBatch','DevelopmentFund',
    'Dividend','DividendVote','EducationFund','ExternalPayment','Grievance',
    'GuarantorDeduction','JournalEntry','LedgerEntry','Loan','ManualCredit',
    'Member','PAYERecord','Payout','PurchasePoll','ReconciliationLog',
    'ReserveAllocation','STR','StatusPost','Subscription','SupportTicket',
    'Unit','Vote','WithdrawalRequest'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
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
      ('Wallet',         'memberId',   'Member'),
      ('Posting',        'entryId',    'JournalEntry'),
      ('DividendEntry',  'dividendId', 'Dividend'),
      ('DeductionItem',  'batchId',    'DeductionBatch'),
      ('Guarantor',      'loanId',     'Loan'),
      ('LoanRepayment',  'loanId',     'Loan'),
      ('VoteBallot',     'voteId',     'Vote'),
      ('VoteCandidate',  'voteId',     'Vote'),
      ('PollBallot',     'pollId',     'PurchasePoll'),
      ('PollOption',     'pollId',     'PurchasePoll'),
      ('DeathValidation','claimId',    'DeathClaim'),
      ('FavoritePayee',  'memberId',   'Member'),
      ('MemberProgress', 'memberId',   'Member')
    ) AS v(child, fk, parent)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id())) WITH CHECK (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id()))',
      r.child || '_tenant_isolation', r.child,
      r.parent, r.child, r.fk,
      r.parent, r.child, r.fk
    );
  END LOOP;
END $$;

-- Session / AccountOfficer are global (not tenant-scoped) — leave unguarded by design.

COMMIT;
