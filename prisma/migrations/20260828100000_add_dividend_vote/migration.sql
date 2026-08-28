-- CreateTable
CREATE TABLE "DividendVote" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "proposedRate" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openedById" TEXT NOT NULL,
    "yesVotes" INTEGER NOT NULL DEFAULT 0,
    "noVotes" INTEGER NOT NULL DEFAULT 0,
    "requiredYesPct" INTEGER NOT NULL DEFAULT 40,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DividendVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DividendVoteBallot" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "choice" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DividendVoteBallot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DividendVote_cooperativeId_status_idx" ON "DividendVote"("cooperativeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DividendVoteBallot_voteId_memberId_key" ON "DividendVoteBallot"("voteId", "memberId");

-- CreateIndex
CREATE INDEX "DividendVoteBallot_memberId_idx" ON "DividendVoteBallot"("memberId");

-- AddForeignKey
ALTER TABLE "DividendVote" ADD CONSTRAINT "DividendVote_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendVote" ADD CONSTRAINT "DividendVote_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendVoteBallot" ADD CONSTRAINT "DividendVoteBallot_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "DividendVote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendVoteBallot" ADD CONSTRAINT "DividendVoteBallot_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
