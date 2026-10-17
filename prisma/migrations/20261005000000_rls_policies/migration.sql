-- =============================================================================
-- Row-Level Security policies (Stage 1: ENABLE, not FORCE)
-- =============================================================================
-- ENABLE (without FORCE) means:
--   * the TABLE OWNER (the role that runs migrations and, currently, the app's
--     DATABASE_URL) BYPASSES RLS -> zero behaviour change, safe to deploy;
--   * any NON-OWNER role (the dedicated `coop_app` role used for enforcement)
--     IS restricted by these policies.
--
-- Enforcement is opt-in per connection: point the app at the non-owner role and
-- route every tenant query through src/lib/tenant-context.ts
-- (setCoopContext / withCoopContext) so `app.current_cooperative_id` is set
-- inside the transaction.
--
-- app.current_coop_id() returns NULL when the GUC is unset -> every comparison
-- is NULL -> deny (fail-closed), never a full leak.
--
-- Table lists below were verified against the live Postgres schema
-- (information_schema.columns WHERE column_name = 'cooperativeId').
-- =============================================================================

BEGIN;

-- The helper lives in a dedicated `app` schema; create it if absent (a fresh
-- database has no `app` schema, and CREATE FUNCTION would otherwise abort).
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_coop_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_cooperative_id', true), '');
$$;

-- Cooperative is keyed by its own id (it has no cooperativeId column).
ALTER TABLE "Cooperative" ENABLE ROW LEVEL SECURITY;
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
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id())) WITH CHECK (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id()))',
      r.child || '_tenant_isolation', r.child,
      r.parent, r.child, r.fk,
      r.parent, r.child, r.fk
    );
  END LOOP;
END $$;

COMMIT;
