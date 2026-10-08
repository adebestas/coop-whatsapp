-- One case per source. A PLAIN unique index (matching the model's
-- @@unique([cooperativeId, sourceType, sourceId])), NOT a partial one. Both
-- Postgres and SQLite treat NULLs as distinct in a unique index, so sourceless
-- disputes (sourceId IS NULL) remain unconstrained while a given grievance/
-- dispute source can only ever produce a single ombudsman case. Platform-level
-- table: no RLS.
CREATE UNIQUE INDEX "OmbudsmanCase_cooperativeId_sourceType_sourceId_key"
  ON "OmbudsmanCase"("cooperativeId", "sourceType", "sourceId");
