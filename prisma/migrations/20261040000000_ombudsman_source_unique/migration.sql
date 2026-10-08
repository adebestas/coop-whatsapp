-- One case per source. Partial unique index so that sourceless disputes
-- (sourceId IS NULL) are unconstrained, while a given grievance/dispute source
-- can only ever produce a single ombudsman case. Platform-level table: no RLS.
CREATE UNIQUE INDEX "OmbudsmanCase_cooperativeId_sourceType_sourceId_key"
  ON "OmbudsmanCase"("cooperativeId", "sourceType", "sourceId")
  WHERE "sourceId" IS NOT NULL;
