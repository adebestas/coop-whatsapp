-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'cash';

-- AlterTable
ALTER TABLE "Guarantor" ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "releasedReason" TEXT;

-- CreateTable
CREATE TABLE "GuarantorSubstitution" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "oldGuarantorId" TEXT NOT NULL,
    "newMemberId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_guarantor',
    "reason" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuarantorSubstitution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopItem" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cashPrice" INTEGER NOT NULL,
    "maxMonths" INTEGER NOT NULL DEFAULT 3,
    "stockQty" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopOrder" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "cashPrice" INTEGER NOT NULL,
    "months" INTEGER NOT NULL,
    "monthlyKobo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "loanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuarantorSubstitution_reference_key" ON "GuarantorSubstitution"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "GuarantorSubstitution_code_key" ON "GuarantorSubstitution"("code");

-- CreateIndex
CREATE INDEX "GuarantorSubstitution_cooperativeId_status_idx" ON "GuarantorSubstitution"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "GuarantorSubstitution_loanId_idx" ON "GuarantorSubstitution"("loanId");

-- CreateIndex
CREATE INDEX "GuarantorSubstitution_newMemberId_status_idx" ON "GuarantorSubstitution"("newMemberId", "status");

-- CreateIndex
CREATE INDEX "ShopItem_cooperativeId_active_idx" ON "ShopItem"("cooperativeId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ShopOrder_ref_key" ON "ShopOrder"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "ShopOrder_loanId_key" ON "ShopOrder"("loanId");

-- CreateIndex
CREATE INDEX "ShopOrder_cooperativeId_status_idx" ON "ShopOrder"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "ShopOrder_memberId_status_idx" ON "ShopOrder"("memberId", "status");

-- AddForeignKey
ALTER TABLE "GuarantorSubstitution" ADD CONSTRAINT "GuarantorSubstitution_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuarantorSubstitution" ADD CONSTRAINT "GuarantorSubstitution_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuarantorSubstitution" ADD CONSTRAINT "GuarantorSubstitution_oldGuarantorId_fkey" FOREIGN KEY ("oldGuarantorId") REFERENCES "Guarantor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuarantorSubstitution" ADD CONSTRAINT "GuarantorSubstitution_newMemberId_fkey" FOREIGN KEY ("newMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuarantorSubstitution" ADD CONSTRAINT "GuarantorSubstitution_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopItem" ADD CONSTRAINT "ShopItem_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopItem" ADD CONSTRAINT "ShopItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ShopItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

