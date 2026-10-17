-- CreateTable
CREATE TABLE "ShareAccount" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "totalPaid" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShareAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareTransaction" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "shareAccountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "pricePerShare" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShareTransaction_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CooperativeConfig" ADD COLUMN "sharePrice" INTEGER NOT NULL DEFAULT 100000,
ADD COLUMN "minShares" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "maxShares" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "allowShareRedemption" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "ShareAccount_cooperativeId_memberId_key" ON "ShareAccount"("cooperativeId", "memberId");
CREATE UNIQUE INDEX "ShareAccount_memberId_key" ON "ShareAccount"("memberId");
CREATE INDEX "ShareAccount_cooperativeId_idx" ON "ShareAccount"("cooperativeId");
CREATE UNIQUE INDEX "ShareTransaction_reference_key" ON "ShareTransaction"("reference");
CREATE INDEX "ShareTransaction_cooperativeId_memberId_createdAt_idx" ON "ShareTransaction"("cooperativeId", "memberId", "createdAt");

-- AddForeignKey
ALTER TABLE "ShareAccount" ADD CONSTRAINT "ShareAccount_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareAccount" ADD CONSTRAINT "ShareAccount_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareTransaction" ADD CONSTRAINT "ShareTransaction_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareTransaction" ADD CONSTRAINT "ShareTransaction_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareTransaction" ADD CONSTRAINT "ShareTransaction_shareAccountId_fkey" FOREIGN KEY ("shareAccountId") REFERENCES "ShareAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
