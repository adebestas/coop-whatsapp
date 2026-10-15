-- Federation / inter-coop: shared-liquidity pool and bilateral inter-coop loans.
-- Platform-level tables (no cooperativeId, no RLS). Mirrors the Federation,
-- FederationMembership, FederationLedgerEntry, FederationPosting, FederationLoan,
-- FederationLoanRepayment and FxRate models in schema.prisma.
CREATE TABLE "Federation" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "baseCurrency" TEXT NOT NULL DEFAULT 'NGN',
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Federation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Federation_code_key" ON "Federation"("code");

CREATE TABLE "FederationMembership" (
  "id" TEXT NOT NULL,
  "federationId" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FederationMembership_federationId_cooperativeId_key" ON "FederationMembership"("federationId", "cooperativeId");
CREATE INDEX "FederationMembership_cooperativeId_idx" ON "FederationMembership"("cooperativeId");
ALTER TABLE "FederationMembership" ADD CONSTRAINT "FederationMembership_federationId_fkey" FOREIGN KEY ("federationId") REFERENCES "Federation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FederationLedgerEntry" (
  "id" TEXT NOT NULL,
  "federationId" TEXT NOT NULL,
  "txRef" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FederationLedgerEntry_txRef_key" ON "FederationLedgerEntry"("txRef");
CREATE INDEX "FederationLedgerEntry_federationId_idx" ON "FederationLedgerEntry"("federationId");
ALTER TABLE "FederationLedgerEntry" ADD CONSTRAINT "FederationLedgerEntry_federationId_fkey" FOREIGN KEY ("federationId") REFERENCES "Federation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FederationPosting" (
  "id" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "cooperativeId" TEXT,
  CONSTRAINT "FederationPosting_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FederationPosting_entryId_idx" ON "FederationPosting"("entryId");
ALTER TABLE "FederationPosting" ADD CONSTRAINT "FederationPosting_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "FederationLedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FederationLoan" (
  "id" TEXT NOT NULL,
  "federationId" TEXT NOT NULL,
  "lenderCooperativeId" TEXT,
  "borrowerCooperativeId" TEXT NOT NULL,
  "principalKobo" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "fxRateToBase" DOUBLE PRECISION NOT NULL,
  "interestRate" DOUBLE PRECISION NOT NULL,
  "termMonths" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "disbursedAt" TIMESTAMP(3),
  "dueAt" TIMESTAMP(3),
  "repaidKobo" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationLoan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FederationLoan_federationId_status_idx" ON "FederationLoan"("federationId", "status");
CREATE INDEX "FederationLoan_borrowerCooperativeId_idx" ON "FederationLoan"("borrowerCooperativeId");
CREATE INDEX "FederationLoan_lenderCooperativeId_idx" ON "FederationLoan"("lenderCooperativeId");
ALTER TABLE "FederationLoan" ADD CONSTRAINT "FederationLoan_federationId_fkey" FOREIGN KEY ("federationId") REFERENCES "Federation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FederationLoanRepayment" (
  "id" TEXT NOT NULL,
  "loanId" TEXT NOT NULL,
  "amountKobo" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "fxRateToBase" DOUBLE PRECISION NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationLoanRepayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FederationLoanRepayment_loanId_idx" ON "FederationLoanRepayment"("loanId");
ALTER TABLE "FederationLoanRepayment" ADD CONSTRAINT "FederationLoanRepayment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "FederationLoan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FxRate" (
  "id" TEXT NOT NULL,
  "federationId" TEXT NOT NULL,
  "baseCurrency" TEXT NOT NULL,
  "quoteCurrency" TEXT NOT NULL,
  "rate" DOUBLE PRECISION NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "setBy" TEXT NOT NULL,
  CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FxRate_federationId_baseCurrency_quoteCurrency_effectiveAt_idx" ON "FxRate"("federationId", "baseCurrency", "quoteCurrency", "effectiveAt");
ALTER TABLE "FxRate" ADD CONSTRAINT "FxRate_federationId_fkey" FOREIGN KEY ("federationId") REFERENCES "Federation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Cooperative" ADD COLUMN "federationFundBalance" INTEGER NOT NULL DEFAULT 0;
