-- =============================================================================
-- Row-Level Security policies (DRAFT — NOT APPLIED)
-- =============================================================================
-- Do NOT place this file in prisma/migrations/. Enabling FORCE ROW LEVEL
-- SECURITY will make every tenant query return zero rows unless the calling
-- code sets the `app.current_cooperative_id` GUC inside the SAME transaction
-- (Postgres session settings are per-connection). Today only the admin API does
-- this (routes/admin.ts:148), and only for a single Prisma client connection.
--
-- To activate safely you must, IN THIS ORDER:
--   1. Wrap ALL tenant queries (chat handlers, money services, schedulers,
--      webhook processors) in `prisma.$transaction` that begins with
--        SELECT set_config('app.current_cooperative_id', $coop, true);
--   2. Apply this migration via `prisma migrate deploy`.
--   3. Flip RLS_ENABLED=1 in CI and run tests/rls-isolation.test.ts (Postgres).
--
-- Until that wrapping exists, these tests correctly skip (tests/rls-isolation.test.ts).
-- =============================================================================

BEGIN;

-- Helper function: the cooperative this connection is currently scoped to.
-- Returns '' when unset, which matches the deny-all fail-closed policy below.
CREATE OR REPLACE FUNCTION app.current_coop_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_cooperative_id', true), '');
$$;

-- ---- Tenant-scoped tables ------------------------------------------------
-- Member
ALTER TABLE "Member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Member" FORCE ROW LEVEL SECURITY;
CREATE POLICY member_tenant_isolation ON "Member"
  USING ("cooperativeId" = app.current_coop_id())
  WITH CHECK ("cooperativeId" = app.current_coop_id());

-- Wallet (owned via Member)
ALTER TABLE "Wallet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Wallet" FORCE ROW LEVEL SECURITY;
CREATE POLICY wallet_tenant_isolation ON "Wallet"
  USING (EXISTS (SELECT 1 FROM "Member" m WHERE m.id = "memberId" AND m."cooperativeId" = app.current_coop_id()));

-- Cooperative (scoped to self; a connection is always inside one coop)
ALTER TABLE "Cooperative" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Cooperative" FORCE ROW LEVEL SECURITY;
CREATE POLICY cooperative_tenant_isolation ON "Cooperative"
  USING (id = app.current_coop_id());

-- Money tables (all carry cooperativeId directly)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Contribution','Loan','Guarantor','LoanRepayment','Payout','WebhookEvent',
    'JournalEntry','Posting','WithdrawalRequest','DeathClaim','DeathValidation',
    'AuditLog','LedgerEntry','ExternalPayment','PurchasePoll','PollOption',
    'PollBallot','GuarantorDeduction','SupportTicket','Vote','VoteCandidate',
    'VoteBallot','Dividend','DividendEntry','Broadcast','CoopPost','DeductionBatch',
    'DeductionItem','DeductionWaiver','CooperativeConfig','DataConsent','PAYERecord',
    'Byelaw','DeathClaimApproval','STR','Grievance','AdminAssistAction','ManualCredit',
    'Beneficiary','ReconciliationLog','ReserveAllocation','EducationFund','DevelopmentFund',
    'StatusPost','FavoritePayee','MemberProgress','AccountOfficerAssignment'
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

-- Posting / DividendEntry / DeductionItem reference cooperative via a parent.
ALTER TABLE "Posting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Posting" FORCE ROW LEVEL SECURITY;
CREATE POLICY posting_tenant_isolation ON "Posting"
  USING (EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j.id = "entryId" AND j."cooperativeId" = app.current_coop_id()));

ALTER TABLE "DividendEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DividendEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY dividendentry_tenant_isolation ON "DividendEntry"
  USING (EXISTS (SELECT 1 FROM "Dividend" d WHERE d.id = "dividendId" AND d."cooperativeId" = app.current_coop_id()));

ALTER TABLE "DeductionItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeductionItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY deductionitem_tenant_isolation ON "DeductionItem"
  USING (EXISTS (SELECT 1 FROM "DeductionBatch" b WHERE b.id = "batchId" AND b."cooperativeId" = app.current_coop_id()));

-- Session / AccountOfficer are global (not tenant-scoped) — leave unguarded by design.

COMMIT;