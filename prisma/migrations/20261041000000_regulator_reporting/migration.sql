CREATE TABLE "RegulatorProfile" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "contactEmail" TEXT,
  "monthlyDueDay" INTEGER NOT NULL DEFAULT 10,
  "quarterlyDueDay" INTEGER NOT NULL DEFAULT 15,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RegulatorProfile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RegulatorProfile_cooperativeId_active_idx" ON "RegulatorProfile"("cooperativeId", "active");
ALTER TABLE "RegulatorProfile" ADD CONSTRAINT "RegulatorProfile_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RegulatorReport" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "periodType" TEXT NOT NULL,
  "packType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'generated',
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "generatedById" TEXT,
  "files" TEXT,
  "dueAt" TIMESTAMP(3),
  "filedAt" TIMESTAMP(3),
  "notes" TEXT,
  CONSTRAINT "RegulatorReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegulatorReport_cooperativeId_period_periodType_packType_key" ON "RegulatorReport"("cooperativeId", "period", "periodType", "packType");
CREATE INDEX "RegulatorReport_cooperativeId_status_idx" ON "RegulatorReport"("cooperativeId", "status");
ALTER TABLE "RegulatorReport" ADD CONSTRAINT "RegulatorReport_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CooperativeConfig" ADD COLUMN "regulatorReportingEnabled" BOOLEAN NOT NULL DEFAULT false;
