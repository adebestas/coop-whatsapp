-- =============================================================================
-- Row-Level Security — Stage 2 (FORCE) — DRAFT, NOT APPLIED
-- =============================================================================
-- Stage 1 (prisma/migrations/20261005000000_rls_policies) already ENABLEd RLS and
-- created the per-cooperative policies. This file only adds FORCE, which removes
-- the table-owner bypass so the policies bite for EVERY role, including the
-- owner.
--
-- Do NOT apply this until the app connects as a NON-OWNER role (see
-- provision_app_role.sql) and every tenant query is routed through
-- src/lib/tenant-context.ts. With FORCE on and the GUC unset,
-- app.current_coop_id() returns NULL, every comparison is NULL, and every
-- tenant query returns zero rows (fail-closed).
--
-- To apply: copy this into
--   prisma/migrations/<timestamp>_rls_force/migration.sql
-- and run `prisma migrate deploy` as the owner.
-- =============================================================================

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- Cooperative is keyed by its own id.
    'Cooperative',
    -- Directly cooperativeId-scoped tables.
    'AccountOfficerAssignment','AdminAssistAction','AuditLog','Beneficiary',
    'BrandingConfig','Broadcast','Byelaw','Committee','CommitteeDecision',
    'Contribution','CoopPost',
    'CooperativeConfig','DeathClaim','DeductionBatch','DevelopmentFund',
    'Dividend','DividendVote','EducationFund','ExternalPayment','Grievance',
    'GuarantorDeduction','JournalEntry','LedgerEntry','Loan','LoanProtection',
    'ManualCredit',
    'Member','PAYERecord','Payout','PurchasePoll','ReconciliationLog',
    'ReserveAllocation','STR','StatusPost','Subscription','SupportTicket',
    'ShareAccount','ShareTransaction',
    'Unit','Vote','WithdrawalRequest',
    -- Child tables reached through a tenant parent.
    'Wallet','Posting','DividendEntry','DeductionItem','Guarantor',
    'LoanRepayment','VoteBallot','VoteCandidate','PollBallot','PollOption',
    'DeathValidation','FavoritePayee','MemberProgress',
    'CommitteeMember','CommitteeVote'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

COMMIT;
