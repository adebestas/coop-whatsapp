-- PERF-3: indexes backing hot-path lookups.

-- Every top-up webhook and the tenant resolver look a member up by virtual
-- account number (Member.virtualAccountNumber was unindexed -> full scan per
-- payment).
CREATE INDEX "Member_virtualAccountNumber_idx" ON "Member"("virtualAccountNumber");

-- Member statements and AML lookups filter payouts by memberId and order by
-- createdAt; Payout had no memberId index at all.
CREATE INDEX "Payout_memberId_createdAt_idx" ON "Payout"("memberId", "createdAt");

-- Journal entries load their postings by entryId (a foreign key with no index).
CREATE INDEX "Posting_entryId_idx" ON "Posting"("entryId");
