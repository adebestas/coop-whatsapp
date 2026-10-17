-- AlterTable
ALTER TABLE "STR" ADD COLUMN "escalatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "STR_status_escalatedAt_idx" ON "STR"("status", "escalatedAt");
