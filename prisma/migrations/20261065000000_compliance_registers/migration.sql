-- Compliance registers: NDPC/SCUML registration evidence, breach register,
-- DPIA register, cross-border transfer register, and corporate beneficial owners.

ALTER TABLE "Cooperative" ADD COLUMN "ndpcRegistrationNumber" TEXT;
ALTER TABLE "Cooperative" ADD COLUMN "ndpcRegisteredAt" TIMESTAMP(3);
ALTER TABLE "Cooperative" ADD COLUMN "scumlNumber" TEXT;
ALTER TABLE "Cooperative" ADD COLUMN "scumlFiledAt" TIMESTAMP(3);
ALTER TABLE "Cooperative" ADD COLUMN "scumlExpiresAt" TIMESTAMP(3);

ALTER TABLE "Member" ADD COLUMN "entityType" TEXT NOT NULL DEFAULT 'individual';
ALTER TABLE "Member" ADD COLUMN "rcNumber" TEXT;

CREATE TABLE "DataBreach" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "discoveredAt" TIMESTAMP(3) NOT NULL,
  "occurredAt" TIMESTAMP(3),
  "affectedCount" INTEGER,
  "dataCategories" TEXT,
  "containment" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "ndpcNotifiedAt" TIMESTAMP(3),
  "ndpcReference" TEXT,
  "subjectsNotifiedAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DataBreach_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DataBreach_cooperativeId_reference_key" ON "DataBreach"("cooperativeId", "reference");
CREATE INDEX "DataBreach_cooperativeId_status_idx" ON "DataBreach"("cooperativeId", "status");
CREATE INDEX "DataBreach_cooperativeId_discoveredAt_idx" ON "DataBreach"("cooperativeId", "discoveredAt");
ALTER TABLE "DataBreach" ADD CONSTRAINT "DataBreach_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DpiaRecord" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "activity" TEXT NOT NULL,
  "dataCategories" TEXT,
  "necessity" TEXT,
  "risks" TEXT,
  "mitigations" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "ownerName" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "nextReviewAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DpiaRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DpiaRecord_cooperativeId_status_idx" ON "DpiaRecord"("cooperativeId", "status");
CREATE INDEX "DpiaRecord_cooperativeId_nextReviewAt_idx" ON "DpiaRecord"("cooperativeId", "nextReviewAt");
ALTER TABLE "DpiaRecord" ADD CONSTRAINT "DpiaRecord_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CrossBorderTransfer" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "dataCategories" TEXT,
  "safeguard" TEXT NOT NULL,
  "safeguardDetail" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrossBorderTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrossBorderTransfer_cooperativeId_status_idx" ON "CrossBorderTransfer"("cooperativeId", "status");
CREATE INDEX "CrossBorderTransfer_cooperativeId_country_idx" ON "CrossBorderTransfer"("cooperativeId", "country");
ALTER TABLE "CrossBorderTransfer" ADD CONSTRAINT "CrossBorderTransfer_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MemberBeneficialOwner" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ownershipPct" DOUBLE PRECISION NOT NULL,
  "idType" TEXT,
  "idNumber" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MemberBeneficialOwner_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MemberBeneficialOwner_cooperativeId_memberId_idx" ON "MemberBeneficialOwner"("cooperativeId", "memberId");
CREATE INDEX "MemberBeneficialOwner_cooperativeId_name_idx" ON "MemberBeneficialOwner"("cooperativeId", "name");
ALTER TABLE "MemberBeneficialOwner" ADD CONSTRAINT "MemberBeneficialOwner_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberBeneficialOwner" ADD CONSTRAINT "MemberBeneficialOwner_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Platform-level watchlist refresh status (no cooperativeId, so no RLS).
CREATE TABLE "SanctionsListRefresh" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "source" TEXT,
  "status" TEXT NOT NULL DEFAULT 'never',
  "fetched" INTEGER NOT NULL DEFAULT 0,
  "created" INTEGER NOT NULL DEFAULT 0,
  "updated" INTEGER NOT NULL DEFAULT 0,
  "deactivated" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SanctionsListRefresh_pkey" PRIMARY KEY ("id")
);

-- Row-Level Security (Stage 1: ENABLE, not FORCE). All four tables carry a
-- cooperativeId column, so they use the direct tenant policy.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['DataBreach','DpiaRecord','CrossBorderTransfer','MemberBeneficialOwner']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("cooperativeId" = app.current_coop_id()) WITH CHECK ("cooperativeId" = app.current_coop_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

COMMIT;
