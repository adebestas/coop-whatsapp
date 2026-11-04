-- AlterTable
ALTER TABLE "DeductionItem" ADD COLUMN     "rolloverOfItemId" TEXT;

-- CreateTable
CREATE TABLE "CommodityScheme" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "season" TEXT,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "pollId" TEXT,
    "supplier" TEXT,
    "quotedCostKobo" INTEGER NOT NULL DEFAULT 0,
    "actualCostKobo" INTEGER,
    "fundingSource" TEXT,
    "purchaseNote" TEXT,
    "purchasedAt" TIMESTAMP(3),
    "purchasedById" TEXT,
    "convertedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommodityScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommoditySchemeItem" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL,
    "unitCostKobo" INTEGER NOT NULL,
    "memberPriceKobo" INTEGER NOT NULL,
    "totalUnits" INTEGER,
    "maxQtyPerMember" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CommoditySchemeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommoditySubscription" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitPriceKobo" INTEGER NOT NULL,
    "totalKobo" INTEGER NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "rejectReason" TEXT,
    "convertedLoanId" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "collectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommoditySubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeductionShortfall" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT,
    "attributedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "rolledToItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeductionShortfall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommodityScheme_reference_key" ON "CommodityScheme"("reference");

-- CreateIndex
CREATE INDEX "CommodityScheme_cooperativeId_status_idx" ON "CommodityScheme"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "CommoditySchemeItem_schemeId_idx" ON "CommoditySchemeItem"("schemeId");

-- CreateIndex
CREATE UNIQUE INDEX "CommoditySubscription_reference_key" ON "CommoditySubscription"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "CommoditySubscription_convertedLoanId_key" ON "CommoditySubscription"("convertedLoanId");

-- CreateIndex
CREATE INDEX "CommoditySubscription_cooperativeId_status_idx" ON "CommoditySubscription"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "CommoditySubscription_memberId_status_idx" ON "CommoditySubscription"("memberId", "status");

-- CreateIndex
CREATE INDEX "DeductionShortfall_cooperativeId_status_idx" ON "DeductionShortfall"("cooperativeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeductionShortfall_batchId_memberId_key" ON "DeductionShortfall"("batchId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "DeductionItem_rolloverOfItemId_key" ON "DeductionItem"("rolloverOfItemId");

-- AddForeignKey
ALTER TABLE "DeductionItem" ADD CONSTRAINT "DeductionItem_rolloverOfItemId_fkey" FOREIGN KEY ("rolloverOfItemId") REFERENCES "DeductionItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommodityScheme" ADD CONSTRAINT "CommodityScheme_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommodityScheme" ADD CONSTRAINT "CommodityScheme_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommoditySchemeItem" ADD CONSTRAINT "CommoditySchemeItem_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "CommodityScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommoditySubscription" ADD CONSTRAINT "CommoditySubscription_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommoditySubscription" ADD CONSTRAINT "CommoditySubscription_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "CommodityScheme"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommoditySubscription" ADD CONSTRAINT "CommoditySubscription_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CommoditySchemeItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommoditySubscription" ADD CONSTRAINT "CommoditySubscription_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionShortfall" ADD CONSTRAINT "DeductionShortfall_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionShortfall" ADD CONSTRAINT "DeductionShortfall_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DeductionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionShortfall" ADD CONSTRAINT "DeductionShortfall_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

