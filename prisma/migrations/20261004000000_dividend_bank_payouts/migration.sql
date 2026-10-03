-- AlterTable
ALTER TABLE "Member" ADD COLUMN "bankAccountName" TEXT;

-- AlterTable
ALTER TABLE "DividendEntry" ADD COLUMN "payoutId" TEXT,
ADD COLUMN "failureReason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DividendEntry_payoutId_key" ON "DividendEntry"("payoutId");

-- AddForeignKey
ALTER TABLE "DividendEntry" ADD CONSTRAINT "DividendEntry_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
