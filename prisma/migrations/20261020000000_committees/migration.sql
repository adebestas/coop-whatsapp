-- CreateTable
CREATE TABLE "Committee" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Committee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommitteeMember" (
    "id" TEXT NOT NULL,
    "committeeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "appointedById" TEXT,
    "appointedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "termEndsAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "CommitteeMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommitteeDecision" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "committeeId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    CONSTRAINT "CommitteeDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommitteeVote" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "vote" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommitteeVote_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CooperativeConfig" ADD COLUMN "creditCommitteeSize" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "supervisoryCommitteeSize" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "boardSize" INTEGER NOT NULL DEFAULT 5;

-- CreateIndex
CREATE UNIQUE INDEX "Committee_cooperativeId_type_key" ON "Committee"("cooperativeId", "type");
CREATE INDEX "Committee_cooperativeId_idx" ON "Committee"("cooperativeId");
CREATE UNIQUE INDEX "CommitteeMember_committeeId_memberId_key" ON "CommitteeMember"("committeeId", "memberId");
CREATE INDEX "CommitteeMember_memberId_idx" ON "CommitteeMember"("memberId");
CREATE UNIQUE INDEX "CommitteeDecision_committeeId_subjectType_subjectId_key" ON "CommitteeDecision"("committeeId", "subjectType", "subjectId");
CREATE INDEX "CommitteeDecision_cooperativeId_status_idx" ON "CommitteeDecision"("cooperativeId", "status");
CREATE UNIQUE INDEX "CommitteeVote_decisionId_memberId_key" ON "CommitteeVote"("decisionId", "memberId");
CREATE INDEX "CommitteeVote_memberId_idx" ON "CommitteeVote"("memberId");

-- AddForeignKey
ALTER TABLE "Committee" ADD CONSTRAINT "Committee_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommitteeMember" ADD CONSTRAINT "CommitteeMember_committeeId_fkey" FOREIGN KEY ("committeeId") REFERENCES "Committee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommitteeMember" ADD CONSTRAINT "CommitteeMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommitteeMember" ADD CONSTRAINT "CommitteeMember_appointedById_fkey" FOREIGN KEY ("appointedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommitteeDecision" ADD CONSTRAINT "CommitteeDecision_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommitteeDecision" ADD CONSTRAINT "CommitteeDecision_committeeId_fkey" FOREIGN KEY ("committeeId") REFERENCES "Committee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommitteeVote" ADD CONSTRAINT "CommitteeVote_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "CommitteeDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommitteeVote" ADD CONSTRAINT "CommitteeVote_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
