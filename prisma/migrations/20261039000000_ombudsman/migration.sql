CREATE TABLE "Ombudsman" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Ombudsman_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Ombudsman_phone_key" ON "Ombudsman"("phone");

CREATE TABLE "OmbudsmanCase" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT,
  "category" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "escalatedBy" TEXT NOT NULL,
  "slaDueAt" TIMESTAMP(3),
  "decision" TEXT,
  "decisionById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "remedy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OmbudsmanCase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OmbudsmanCase_cooperativeId_status_idx" ON "OmbudsmanCase"("cooperativeId", "status");
CREATE INDEX "OmbudsmanCase_memberId_idx" ON "OmbudsmanCase"("memberId");
CREATE INDEX "OmbudsmanCase_status_slaDueAt_idx" ON "OmbudsmanCase"("status", "slaDueAt");

CREATE TABLE "OmbudsmanCaseEvent" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OmbudsmanCaseEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OmbudsmanCaseEvent_caseId_createdAt_idx" ON "OmbudsmanCaseEvent"("caseId", "createdAt");
ALTER TABLE "OmbudsmanCaseEvent" ADD CONSTRAINT "OmbudsmanCaseEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OmbudsmanCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CooperativeConfig" ADD COLUMN "ombudsmanSlaDays" INTEGER NOT NULL DEFAULT 7;
