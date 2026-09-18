-- CreateTable
CREATE TABLE "Cooperative" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "state" TEXT,
    "country" TEXT NOT NULL DEFAULT 'NG',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "adminPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "loanInterestRate" REAL NOT NULL DEFAULT 2,
    "dailyPayoutLimit" INTEGER NOT NULL DEFAULT 100000000,
    "reserveFundBalance" INTEGER NOT NULL DEFAULT 0,
    "memberSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReconciliationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "totalWalletBalances" INTEGER NOT NULL,
    "bankBalance" INTEGER NOT NULL,
    "discrepancy" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "performedBy" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "activeLoans" INTEGER NOT NULL,
    "activeLoanTotal" INTEGER NOT NULL,
    "pendingWithdrawals" INTEGER NOT NULL,
    "pendingWithdrawalTotal" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReconciliationLog_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReserveAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "referenceId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReserveAllocation_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EducationFund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "referenceId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EducationFund_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DevelopmentFund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "referenceId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DevelopmentFund_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contactPhone" TEXT,
    "email" TEXT,
    "dateOfBirth" DATETIME,
    "nextOfKinName" TEXT,
    "nextOfKinPhone" TEXT,
    "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "bvn" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "state" TEXT,
    "lga" TEXT,
    "pin" TEXT,
    "pinFailedCount" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" DATETIME,
    "totpSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "bankAccountNumber" TEXT,
    "bankCode" TEXT,
    "bankName" TEXT,
    "lastWithdrawalAt" DATETIME,
    "withdrawalOverride" BOOLEAN NOT NULL DEFAULT false,
    "frozenAt" DATETIME,
    "altChannelId" TEXT,
    "preferredChannel" TEXT,
    "lastStatementSentAt" DATETIME,
    "lastBirthdayGreetedYear" INTEGER,
    "lastAnniversaryGreetedYear" INTEGER,
    "virtualAccountNumber" TEXT,
    "virtualAccountBank" TEXT,
    "virtualAccountProvider" TEXT,
    "virtualAccountExpiresAt" DATETIME,
    "unitId" TEXT,
    "autoSaveAmount" INTEGER,
    "autoSaveInterval" TEXT,
    "autoSaveNextDue" DATETIME,
    "autoSaveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cooperativeId" TEXT NOT NULL,
    "consentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "salaryAmount" INTEGER,
    "salaryKind" TEXT,
    "monthlyDeduction" INTEGER,
    "dataConsentGiven" BOOLEAN NOT NULL DEFAULT false,
    "sessionsRevokedAt" DATETIME,
    CONSTRAINT "Member_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Member_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AccountOfficer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AccountOfficerAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountOfficerId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "AccountOfficerAssignment_accountOfficerId_fkey" FOREIGN KEY ("accountOfficerId") REFERENCES "AccountOfficer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountOfficerAssignment_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "adminMemberId" TEXT,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Unit_adminMemberId_fkey" FOREIGN KEY ("adminMemberId") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Unit_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "totalSaved" INTEGER NOT NULL DEFAULT 0,
    "memberId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Wallet_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'savings',
    "note" TEXT,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" DATETIME,
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Contribution_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Contribution_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amount" INTEGER NOT NULL,
    "interestRate" REAL NOT NULL DEFAULT 0,
    "tenureMonths" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "balance" INTEGER NOT NULL,
    "monthlyPayment" INTEGER,
    "bankAccountNumber" TEXT,
    "bankCode" TEXT,
    "bankName" TEXT,
    "disbursementStatus" TEXT,
    "disbursementError" TEXT,
    "adminCharge" INTEGER NOT NULL DEFAULT 200000,
    "disbursementAmount" INTEGER,
    "adminApprovedById" TEXT,
    "accountOfficerApprovedById" TEXT,
    "accountOfficerApprovedAt" DATETIME,
    "finalApprovedById" TEXT,
    "superApproved2ById" TEXT,
    "disbursedAt" DATETIME,
    "dueDate" DATETIME,
    "queuePosition" INTEGER,
    "queueJoinedAt" DATETIME,
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" DATETIME,
    CONSTRAINT "Loan_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Loan_superApproved2ById_fkey" FOREIGN KEY ("superApproved2ById") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Loan_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Guarantor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loanId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Guarantor_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Guarantor_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GuarantorVerification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loanId" TEXT NOT NULL,
    "guarantorId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuarantorVerification_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuarantorVerification_guarantorId_fkey" FOREIGN KEY ("guarantorId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoanRepayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amount" INTEGER NOT NULL,
    "loanId" TEXT NOT NULL,
    "paidAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoanRepayment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amount" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT,
    "providerRef" TEXT,
    "note" TEXT,
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Payout_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payout_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "kind" TEXT,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "txRef" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JournalEntry_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Posting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entryId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "memberId" TEXT,
    CONSTRAINT "Posting_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "bankAccountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT,
    "payoutReference" TEXT,
    "adminApprovedAt" DATETIME,
    "adminApprovedById" TEXT,
    "finalizedAt" DATETIME,
    "finalizedById" TEXT,
    "rejectedAt" DATETIME,
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WithdrawalRequest_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WithdrawalRequest_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Beneficiary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT,
    "accountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Beneficiary_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Beneficiary_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

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

-- CreateTable
CREATE TABLE "MemberProgress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT NOT NULL,
    "currentLesson" INTEGER NOT NULL DEFAULT 1,
    "completedLessons" TEXT NOT NULL DEFAULT '[]',
    "enrolledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "lastLessonAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MemberProgress_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StatusPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "scheduledTime" DATETIME NOT NULL,
    "postedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatusPost_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeathClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_certificate',
    "certificateRef" TEXT,
    "familyAccountNumber" TEXT,
    "familyBankCode" TEXT,
    "familyBankName" TEXT,
    "familyPhone" TEXT,
    "familyConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "familyConfirmedAt" DATETIME,
    "familyConfirmCode" TEXT,
    "approvalsRequired" INTEGER NOT NULL DEFAULT 2,
    "approvalCount" INTEGER NOT NULL DEFAULT 0,
    "waitingPeriodEnd" DATETIME,
    "payoutReference" TEXT,
    "debitedAmount" INTEGER,
    "createdById" TEXT,
    "approvedAt" DATETIME,
    "finalizedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeathClaim_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeathClaim_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeathValidation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "claimId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeathValidation_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "DeathClaim" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeathValidation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorPhone" TEXT NOT NULL,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "amount" INTEGER,
    "balanceBefore" INTEGER,
    "balanceAfter" INTEGER,
    "detail" TEXT,
    "prevHash" TEXT,
    "hash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "reference" TEXT,
    "fundType" TEXT NOT NULL DEFAULT 'operational',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExternalPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "beneficiaryName" TEXT NOT NULL,
    "bankAccountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT,
    "amount" INTEGER NOT NULL,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "initiatedById" TEXT NOT NULL,
    "approved1ById" TEXT,
    "approved2ById" TEXT,
    "approved3ById" TEXT,
    "lastApprovedAt" DATETIME,
    "payoutReference" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExternalPayment_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ExternalPayment_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ExternalPayment_approved1ById_fkey" FOREIGN KEY ("approved1ById") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExternalPayment_approved2ById_fkey" FOREIGN KEY ("approved2ById") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExternalPayment_approved3ById_fkey" FOREIGN KEY ("approved3ById") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchasePoll" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "winnerOptionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    CONSTRAINT "PurchasePoll_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchasePoll_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PollOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pollId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "estimatedCost" INTEGER NOT NULL,
    "bankAccountNumber" TEXT,
    "bankCode" TEXT,
    "bankName" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "PurchasePoll" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PollOption_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PollBallot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pollId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PollBallot_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "PurchasePoll" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PollBallot_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "PollOption" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PollBallot_voterId_fkey" FOREIGN KEY ("voterId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GuarantorDeduction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "guarantorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'notified',
    "noticeSentAt" DATETIME NOT NULL,
    "deductAt" DATETIME NOT NULL,
    "deductedAt" DATETIME,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuarantorDeduction_guarantorId_fkey" FOREIGN KEY ("guarantorId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedToId" TEXT,
    "resolution" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "slaDeadline" DATETIME,
    "firstResponseAt" DATETIME,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupportTicket_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SupportTicket_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SupportTicket_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Vote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "unitId" TEXT,
    "kind" TEXT NOT NULL,
    "electionType" TEXT NOT NULL DEFAULT 'general',
    "position" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "winnerId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "quorumRequired" INTEGER NOT NULL DEFAULT 30,
    "lastResultBroadcastAt" DATETIME,
    CONSTRAINT "Vote_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VoteCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "voteId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    CONSTRAINT "VoteCandidate_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "Vote" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VoteCandidate_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VoteBallot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "voteId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoteBallot_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "Vote" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VoteBallot_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "VoteCandidate" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VoteBallot_voterId_fkey" FOREIGN KEY ("voterId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DividendVote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "proposedRate" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openedById" TEXT NOT NULL,
    "yesVotes" INTEGER NOT NULL DEFAULT 0,
    "noVotes" INTEGER NOT NULL DEFAULT 0,
    "requiredYesPct" INTEGER NOT NULL DEFAULT 40,
    "expiresAt" DATETIME NOT NULL,
    "closedById" TEXT,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DividendVote_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DividendVote_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DividendVoteBallot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "voteId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "choice" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DividendVoteBallot_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "DividendVote" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DividendVoteBallot_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Dividend" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "rate" REAL NOT NULL,
    "totalPool" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "distributedAt" DATETIME,
    CONSTRAINT "Dividend_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DividendEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dividendId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DividendEntry_dividendId_fkey" FOREIGN KEY ("dividendId") REFERENCES "Dividend" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DividendEntry_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'coop',
    "unitId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Broadcast_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Broadcast_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phone" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'idle',
    "data" TEXT NOT NULL DEFAULT '{}',
    "lastInboundAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CoopPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "incumbentId" TEXT,
    "appointedById" TEXT,
    "appointedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CoopPost_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CoopPost_incumbentId_fkey" FOREIGN KEY ("incumbentId") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeductionBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalAmount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeductionBatch_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeductionBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeductionBatch_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeductionItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'savings',
    "loanId" TEXT,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "creditedAt" DATETIME,
    CONSTRAINT "DeductionItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DeductionBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeductionItem_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeductionWaiver" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeductionWaiver_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CooperativeConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "loanInterestRate" INTEGER NOT NULL DEFAULT 10,
    "serviceChargePercent" INTEGER NOT NULL DEFAULT 2,
    "minContribution" INTEGER NOT NULL DEFAULT 200000,
    "minSavings" INTEGER NOT NULL DEFAULT 100000,
    "minWithdrawal" INTEGER NOT NULL DEFAULT 500000,
    "maxWithdrawal" INTEGER NOT NULL DEFAULT 5000000,
    "withdrawalCooldownMonths" INTEGER NOT NULL DEFAULT 6,
    "lateFinePercent" INTEGER NOT NULL DEFAULT 5,
    "maxLoanMultiplier" INTEGER NOT NULL DEFAULT 3,
    "autoApproveLoans" BOOLEAN NOT NULL DEFAULT false,
    "requireGuarantors" BOOLEAN NOT NULL DEFAULT true,
    "minGuarantors" INTEGER NOT NULL DEFAULT 2,
    "statusEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nextAGMDate" DATETIME,
    "lastDividendRate" INTEGER,
    "pendingDividendRate" INTEGER,
    "taxIdentificationNumber" TEXT,
    "cooperativeType" TEXT NOT NULL DEFAULT 'member',
    "commercialIncome" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CooperativeConfig_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BrandingConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "welcomeMessage" TEXT,
    "footerText" TEXT,
    "logoUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrandingConfig_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "memberLimit" INTEGER NOT NULL DEFAULT 20,
    "monthlyPrice" INTEGER NOT NULL DEFAULT 0,
    "currentPeriodEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DataConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DataConsent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PAYERecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "grossAmount" INTEGER NOT NULL,
    "taxAmount" INTEGER NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "remittedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PAYERecord_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PAYERecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Byelaw" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Byelaw_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeathClaimApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deathClaimId" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeathClaimApproval_deathClaimId_fkey" FOREIGN KEY ("deathClaimId") REFERENCES "DeathClaim" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeathClaimApproval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "STR" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "filedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "STR_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "STR_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Grievance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "response" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Grievance_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Grievance_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Grievance_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminAssistAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetMemberId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "metadata" JSONB,
    "otp" TEXT NOT NULL,
    "otpExpiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" DATETIME,
    "confirmedBy" TEXT,
    CONSTRAINT "AdminAssistAction_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AdminAssistAction_targetMemberId_fkey" FOREIGN KEY ("targetMemberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AdminAssistAction_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ManualCredit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "narration" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedById" TEXT,
    "rejectedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" DATETIME,
    "rejectedAt" DATETIME,
    CONSTRAINT "ManualCredit_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManualCredit_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ManualCredit_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ManualCredit_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Cooperative_code_key" ON "Cooperative"("code");

-- CreateIndex
CREATE INDEX "Cooperative_status_idx" ON "Cooperative"("status");

-- CreateIndex
CREATE INDEX "Cooperative_code_idx" ON "Cooperative"("code");

-- CreateIndex
CREATE INDEX "ReconciliationLog_cooperativeId_createdAt_idx" ON "ReconciliationLog"("cooperativeId", "createdAt");

-- CreateIndex
CREATE INDEX "ReserveAllocation_cooperativeId_createdAt_idx" ON "ReserveAllocation"("cooperativeId", "createdAt");

-- CreateIndex
CREATE INDEX "EducationFund_cooperativeId_createdAt_idx" ON "EducationFund"("cooperativeId", "createdAt");

-- CreateIndex
CREATE INDEX "DevelopmentFund_cooperativeId_createdAt_idx" ON "DevelopmentFund"("cooperativeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Member_code_key" ON "Member"("code");

-- CreateIndex
CREATE INDEX "Member_phone_idx" ON "Member"("phone");

-- CreateIndex
CREATE INDEX "Member_cooperativeId_role_idx" ON "Member"("cooperativeId", "role");

-- CreateIndex
CREATE INDEX "Member_status_idx" ON "Member"("status");

-- CreateIndex
CREATE INDEX "Member_cooperativeId_status_role_idx" ON "Member"("cooperativeId", "status", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Member_cooperativeId_phone_key" ON "Member"("cooperativeId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "AccountOfficer_email_key" ON "AccountOfficer"("email");

-- CreateIndex
CREATE INDEX "AccountOfficerAssignment_accountOfficerId_idx" ON "AccountOfficerAssignment"("accountOfficerId");

-- CreateIndex
CREATE INDEX "AccountOfficerAssignment_cooperativeId_idx" ON "AccountOfficerAssignment"("cooperativeId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountOfficerAssignment_accountOfficerId_cooperativeId_key" ON "AccountOfficerAssignment"("accountOfficerId", "cooperativeId");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_cooperativeId_code_key" ON "Unit"("cooperativeId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_memberId_key" ON "Wallet"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Contribution_reference_key" ON "Contribution"("reference");

-- CreateIndex
CREATE INDEX "Contribution_memberId_status_idx" ON "Contribution"("memberId", "status");

-- CreateIndex
CREATE INDEX "Contribution_cooperativeId_createdAt_idx" ON "Contribution"("cooperativeId", "createdAt");

-- CreateIndex
CREATE INDEX "Contribution_cooperativeId_status_createdAt_idx" ON "Contribution"("cooperativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Loan_memberId_status_idx" ON "Loan"("memberId", "status");

-- CreateIndex
CREATE INDEX "Loan_cooperativeId_status_idx" ON "Loan"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "Loan_status_createdAt_idx" ON "Loan"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Loan_cooperativeId_status_queuePosition_idx" ON "Loan"("cooperativeId", "status", "queuePosition");

-- CreateIndex
CREATE INDEX "Loan_accountOfficerApprovedById_idx" ON "Loan"("accountOfficerApprovedById");

-- CreateIndex
CREATE UNIQUE INDEX "Guarantor_code_key" ON "Guarantor"("code");

-- CreateIndex
CREATE INDEX "Guarantor_code_idx" ON "Guarantor"("code");

-- CreateIndex
CREATE INDEX "Guarantor_memberId_status_idx" ON "Guarantor"("memberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Guarantor_loanId_memberId_key" ON "Guarantor"("loanId", "memberId");

-- CreateIndex
CREATE INDEX "GuarantorVerification_loanId_idx" ON "GuarantorVerification"("loanId");

-- CreateIndex
CREATE INDEX "GuarantorVerification_guarantorId_idx" ON "GuarantorVerification"("guarantorId");

-- CreateIndex
CREATE UNIQUE INDEX "GuarantorVerification_loanId_guarantorId_key" ON "GuarantorVerification"("loanId", "guarantorId");

-- CreateIndex
CREATE INDEX "LoanRepayment_loanId_paidAt_idx" ON "LoanRepayment"("loanId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_reference_key" ON "Payout"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payout_status_createdAt_idx" ON "Payout"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Payout_cooperativeId_status_createdAt_idx" ON "Payout"("cooperativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_provider_receivedAt_idx" ON "WebhookEvent"("provider", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_txRef_key" ON "JournalEntry"("txRef");

-- CreateIndex
CREATE INDEX "Posting_account_idx" ON "Posting"("account");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_memberId_status_idx" ON "WithdrawalRequest"("memberId", "status");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_cooperativeId_status_idx" ON "WithdrawalRequest"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_status_createdAt_idx" ON "WithdrawalRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Beneficiary_cooperativeId_accountNumber_idx" ON "Beneficiary"("cooperativeId", "accountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Beneficiary_cooperativeId_accountNumber_bankCode_key" ON "Beneficiary"("cooperativeId", "accountNumber", "bankCode");

-- CreateIndex
CREATE INDEX "FavoritePayee_memberId_idx" ON "FavoritePayee"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "FavoritePayee_memberId_name_key" ON "FavoritePayee"("memberId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MemberProgress_memberId_key" ON "MemberProgress"("memberId");

-- CreateIndex
CREATE INDEX "MemberProgress_memberId_idx" ON "MemberProgress"("memberId");

-- CreateIndex
CREATE INDEX "StatusPost_cooperativeId_idx" ON "StatusPost"("cooperativeId");

-- CreateIndex
CREATE INDEX "StatusPost_scheduledTime_idx" ON "StatusPost"("scheduledTime");

-- CreateIndex
CREATE INDEX "DeathClaim_memberId_status_idx" ON "DeathClaim"("memberId", "status");

-- CreateIndex
CREATE INDEX "DeathClaim_cooperativeId_status_idx" ON "DeathClaim"("cooperativeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeathValidation_claimId_memberId_key" ON "DeathValidation"("claimId", "memberId");

-- CreateIndex
CREATE INDEX "AuditLog_cooperativeId_createdAt_idx" ON "AuditLog"("cooperativeId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "LedgerEntry_cooperativeId_createdAt_idx" ON "LedgerEntry"("cooperativeId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_cooperativeId_fundType_idx" ON "LedgerEntry"("cooperativeId", "fundType");

-- CreateIndex
CREATE INDEX "ExternalPayment_cooperativeId_status_idx" ON "ExternalPayment"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "ExternalPayment_initiatedById_status_idx" ON "ExternalPayment"("initiatedById", "status");

-- CreateIndex
CREATE INDEX "PurchasePoll_cooperativeId_status_idx" ON "PurchasePoll"("cooperativeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PollBallot_pollId_voterId_key" ON "PollBallot"("pollId", "voterId");

-- CreateIndex
CREATE INDEX "GuarantorDeduction_cooperativeId_idx" ON "GuarantorDeduction"("cooperativeId");

-- CreateIndex
CREATE INDEX "GuarantorDeduction_status_deductAt_idx" ON "GuarantorDeduction"("status", "deductAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuarantorDeduction_loanId_guarantorId_key" ON "GuarantorDeduction"("loanId", "guarantorId");

-- CreateIndex
CREATE INDEX "SupportTicket_cooperativeId_status_idx" ON "SupportTicket"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "Vote_cooperativeId_status_idx" ON "Vote"("cooperativeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VoteCandidate_voteId_memberId_key" ON "VoteCandidate"("voteId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "VoteBallot_voteId_voterId_key" ON "VoteBallot"("voteId", "voterId");

-- CreateIndex
CREATE INDEX "DividendVote_cooperativeId_status_idx" ON "DividendVote"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "DividendVoteBallot_memberId_idx" ON "DividendVoteBallot"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "DividendVoteBallot_voteId_memberId_key" ON "DividendVoteBallot"("voteId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Dividend_reference_key" ON "Dividend"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "DividendEntry_dividendId_memberId_key" ON "DividendEntry"("dividendId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_phone_key" ON "Session"("phone");

-- CreateIndex
CREATE INDEX "Session_updatedAt_idx" ON "Session"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoopPost_cooperativeId_title_key" ON "CoopPost"("cooperativeId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "DeductionBatch_ref_key" ON "DeductionBatch"("ref");

-- CreateIndex
CREATE INDEX "DeductionBatch_cooperativeId_idx" ON "DeductionBatch"("cooperativeId");

-- CreateIndex
CREATE UNIQUE INDEX "DeductionItem_batchId_memberId_kind_key" ON "DeductionItem"("batchId", "memberId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DeductionWaiver_memberId_period_key" ON "DeductionWaiver"("memberId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "CooperativeConfig_cooperativeId_key" ON "CooperativeConfig"("cooperativeId");

-- CreateIndex
CREATE INDEX "CooperativeConfig_cooperativeId_idx" ON "CooperativeConfig"("cooperativeId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandingConfig_cooperativeId_key" ON "BrandingConfig"("cooperativeId");

-- CreateIndex
CREATE INDEX "BrandingConfig_cooperativeId_idx" ON "BrandingConfig"("cooperativeId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_cooperativeId_key" ON "Subscription"("cooperativeId");

-- CreateIndex
CREATE INDEX "Subscription_cooperativeId_idx" ON "Subscription"("cooperativeId");

-- CreateIndex
CREATE INDEX "DataConsent_memberId_idx" ON "DataConsent"("memberId");

-- CreateIndex
CREATE INDEX "PAYERecord_cooperativeId_year_month_idx" ON "PAYERecord"("cooperativeId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "PAYERecord_cooperativeId_memberId_month_year_key" ON "PAYERecord"("cooperativeId", "memberId", "month", "year");

-- CreateIndex
CREATE INDEX "Byelaw_cooperativeId_idx" ON "Byelaw"("cooperativeId");

-- CreateIndex
CREATE INDEX "DeathClaimApproval_deathClaimId_idx" ON "DeathClaimApproval"("deathClaimId");

-- CreateIndex
CREATE UNIQUE INDEX "DeathClaimApproval_deathClaimId_approvedById_key" ON "DeathClaimApproval"("deathClaimId", "approvedById");

-- CreateIndex
CREATE INDEX "STR_cooperativeId_createdAt_idx" ON "STR"("cooperativeId", "createdAt");

-- CreateIndex
CREATE INDEX "STR_memberId_status_idx" ON "STR"("memberId", "status");

-- CreateIndex
CREATE INDEX "Grievance_cooperativeId_status_idx" ON "Grievance"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "Grievance_memberId_idx" ON "Grievance"("memberId");

-- CreateIndex
CREATE INDEX "AdminAssistAction_cooperativeId_status_createdAt_idx" ON "AdminAssistAction"("cooperativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAssistAction_targetMemberId_status_idx" ON "AdminAssistAction"("targetMemberId", "status");

-- CreateIndex
CREATE INDEX "ManualCredit_cooperativeId_status_createdAt_idx" ON "ManualCredit"("cooperativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ManualCredit_memberId_status_idx" ON "ManualCredit"("memberId", "status");
