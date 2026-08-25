-- CreateTable
CREATE TABLE "FavoritePayee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT,
    "lastUsedAt" DATETIME,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FavoritePayee_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FavoritePayee_memberId_idx" ON "FavoritePayee"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "FavoritePayee_memberId_name_key" ON "FavoritePayee"("memberId", "name");
