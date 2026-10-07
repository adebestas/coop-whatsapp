-- Group / VSLA / ROSCA (Feature 6): data model only.
-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "contributionAmount" INTEGER NOT NULL,
    "cycleLength" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotationPosition" INTEGER,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupCycle" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "payoutMemberId" TEXT,
    "shareOutAmount" INTEGER,
    CONSTRAINT "GroupCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupContribution" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupContribution_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN "groupId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Group_cooperativeId_code_key" ON "Group"("cooperativeId", "code");
CREATE INDEX "Group_cooperativeId_status_idx" ON "Group"("cooperativeId", "status");
CREATE UNIQUE INDEX "GroupMember_groupId_memberId_key" ON "GroupMember"("groupId", "memberId");
CREATE INDEX "GroupMember_memberId_idx" ON "GroupMember"("memberId");
CREATE UNIQUE INDEX "GroupCycle_groupId_cycleNumber_key" ON "GroupCycle"("groupId", "cycleNumber");
CREATE INDEX "GroupCycle_cooperativeId_status_idx" ON "GroupCycle"("cooperativeId", "status");
CREATE INDEX "GroupContribution_groupId_createdAt_idx" ON "GroupContribution"("groupId", "createdAt");
CREATE INDEX "GroupContribution_cycleId_idx" ON "GroupContribution"("cycleId");
CREATE INDEX "GroupContribution_memberId_idx" ON "GroupContribution"("memberId");
CREATE INDEX "Loan_groupId_idx" ON "Loan"("groupId");

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Group" ADD CONSTRAINT "Group_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupCycle" ADD CONSTRAINT "GroupCycle_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupCycle" ADD CONSTRAINT "GroupCycle_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupCycle" ADD CONSTRAINT "GroupCycle_payoutMemberId_fkey" FOREIGN KEY ("payoutMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GroupContribution" ADD CONSTRAINT "GroupContribution_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupContribution" ADD CONSTRAINT "GroupContribution_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "GroupCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupContribution" ADD CONSTRAINT "GroupContribution_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
