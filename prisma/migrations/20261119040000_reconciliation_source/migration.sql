-- Provider-balance reconciliation (Phase 6).
--
-- ReconciliationLog gains `source` so a provider snapshot can be told apart
-- from the internal wallet/bank equation without changing the existing rows.

ALTER TABLE "ReconciliationLog" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'internal';
