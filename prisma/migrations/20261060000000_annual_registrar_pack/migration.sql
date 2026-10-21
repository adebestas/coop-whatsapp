ALTER TABLE "RegulatorProfile" ADD COLUMN "annualDueMonth" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "RegulatorProfile" ADD COLUMN "annualDueDay" INTEGER NOT NULL DEFAULT 31;
ALTER TABLE "RegulatorReport" ADD COLUMN "acknowledgementId" TEXT;
