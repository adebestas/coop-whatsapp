-- A16: sanctions / PEP screening (CFT control).
-- SanctionsEntry is a platform-level watchlist (no tenant scope, no RLS).
-- ScreeningResult is tenant-scoped and gets an RLS policy below.

-- AlterTable
ALTER TABLE "Member" ADD COLUMN "screeningStatus" TEXT NOT NULL DEFAULT 'unset',
ADD COLUMN "screeningAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SanctionsEntry" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "aliases" TEXT NOT NULL DEFAULT '[]',
  "listType" TEXT NOT NULL DEFAULT 'sanction',
  "country" TEXT,
  "source" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SanctionsEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningResult" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT,
  "subjectName" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "score" DOUBLE PRECISION,
  "provider" TEXT NOT NULL,
  "matches" TEXT NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScreeningResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SanctionsEntry_name_idx" ON "SanctionsEntry"("name");

-- CreateIndex
CREATE INDEX "SanctionsEntry_isActive_idx" ON "SanctionsEntry"("isActive");

-- CreateIndex
CREATE INDEX "ScreeningResult_cooperativeId_idx" ON "ScreeningResult"("cooperativeId");

-- CreateIndex
CREATE INDEX "ScreeningResult_subjectName_idx" ON "ScreeningResult"("subjectName");

-- RLS: ScreeningResult carries cooperativeId, so it must be tenant-isolated
-- (same semantics as the other RLS migrations: owner bypasses, non-owner is
-- restricted to app.current_coop_id()).
ALTER TABLE "ScreeningResult" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ScreeningResult_tenant_isolation" ON "ScreeningResult"
  USING ("cooperativeId" = app.current_coop_id())
  WITH CHECK ("cooperativeId" = app.current_coop_id());
