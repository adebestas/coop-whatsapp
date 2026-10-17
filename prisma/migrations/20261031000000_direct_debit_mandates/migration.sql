CREATE TABLE "Mandate" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerMandateId" TEXT,
  "providerReference" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "amountCap" INTEGER NOT NULL,
  "bankAccountNumber" TEXT NOT NULL,
  "bankCode" TEXT NOT NULL,
  "bankName" TEXT,
  "accountName" TEXT,
  "authorizationUrl" TEXT,
  "purposes" TEXT NOT NULL DEFAULT 'savings,loan,group',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "authorizedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "lastDebitAt" TIMESTAMP(3),
  CONSTRAINT "Mandate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Mandate_providerReference_key" ON "Mandate"("providerReference");
CREATE INDEX "Mandate_cooperativeId_memberId_idx" ON "Mandate"("cooperativeId", "memberId");
CREATE INDEX "Mandate_cooperativeId_status_idx" ON "Mandate"("cooperativeId", "status");
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MandateDebit" (
  "id" TEXT NOT NULL,
  "mandateId" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "targetId" TEXT,
  "amount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "providerRef" TEXT NOT NULL,
  "providerTransactionId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "MandateDebit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MandateDebit_providerRef_key" ON "MandateDebit"("providerRef");
CREATE INDEX "MandateDebit_mandateId_status_idx" ON "MandateDebit"("mandateId", "status");
CREATE INDEX "MandateDebit_cooperativeId_status_idx" ON "MandateDebit"("cooperativeId", "status");
CREATE INDEX "MandateDebit_status_nextRetryAt_idx" ON "MandateDebit"("status", "nextRetryAt");
ALTER TABLE "MandateDebit" ADD CONSTRAINT "MandateDebit_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CooperativeConfig" ADD COLUMN "directDebitEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CooperativeConfig" ADD COLUMN "directDebitMaxCap" INTEGER NOT NULL DEFAULT 0;
