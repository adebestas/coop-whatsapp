-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Cooperative" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "state" TEXT,
    "country" TEXT NOT NULL DEFAULT 'NG',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "adminPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "loanInterestRate" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "dailyPayoutLimit" INTEGER NOT NULL DEFAULT 100000000,
    "reserveFundBalance" INTEGER NOT NULL DEFAULT 0,
    "memberSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cooperative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationLog" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReserveAllocation" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "referenceId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReserveAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EducationFund" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "referenceId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EducationFund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentFund" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "referenceId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevelopmentFund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contactPhone" TEXT,
    "email" TEXT,
    "dateOfBirth" TIMESTAMP(3),
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
    "pinLockedUntil" TIMESTAMP(3),
    "totpSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "bankAccountNumber" TEXT,
    "bankCode" TEXT,
    "bankName" TEXT,
    "lastWithdrawalAt" TIMESTAMP(3),
    "withdrawalOverride" BOOLEAN NOT NULL DEFAULT false,
    "frozenAt" TIMESTAMP(3),
    "altChannelId" TEXT,
    "preferredChannel" TEXT,
    "lastStatementSentAt" TIMESTAMP(3),
    "lastBirthdayGreetedYear" INTEGER,
    "lastAnniversaryGreetedYear" INTEGER,
    "virtualAccountNumber" TEXT,
    "virtualAccountBank" TEXT,
    "virtualAccountProvider" TEXT,
    "virtualAccountExpiresAt" TIMESTAMP(3),
    "unitId" TEXT,
    "autoSaveAmount" INTEGER,
    "autoSaveInterval" TEXT,
    "autoSaveNextDue" TIMESTAMP(3),
    "autoSaveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cooperativeId" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "salaryAmount" INTEGER,
    "salaryKind" TEXT,
    "monthlyDeduction" INTEGER,
    "dataConsentGiven" BOOLEAN NOT NULL DEFAULT false,
    "sessionsRevokedAt" TIMESTAMP(3),
    "tier" TEXT NOT NULL DEFAULT 'tier1',

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "adminMemberId" TEXT,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "totalSaved" INTEGER NOT NULL DEFAULT 0,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'savings',
    "note" TEXT,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "interestRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
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
    "finalApprovedById" TEXT,
    "superApproved2ById" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "queuePosition" INTEGER,
    "queueJoinedAt" TIMESTAMP(3),
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guarantor" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guarantor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanRepayment" (
    "id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "loanId" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanRepayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT,
    "providerRef" TEXT,
    "note" TEXT,
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "txRef" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Posting" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "memberId" TEXT,

    CONSTRAINT "Posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "bankAccountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT,
    "payoutReference" TEXT,
    "adminApprovedAt" TIMESTAMP(3),
    "adminApprovedById" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "finalizedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Beneficiary" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT,
    "accountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Beneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FavoritePayee" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoritePayee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberProgress" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "currentLesson" INTEGER NOT NULL DEFAULT 1,
    "completedLessons" TEXT NOT NULL DEFAULT '[]',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastLessonAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusPost" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "scheduledTime" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeathClaim" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_certificate',
    "certificateRef" TEXT,
    "familyAccountNumber" TEXT,
    "familyBankCode" TEXT,
    "familyBankName" TEXT,
    "familyPhone" TEXT,
    "familyConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "familyConfirmedAt" TIMESTAMP(3),
    "familyConfirmCode" TEXT,
    "approvalsRequired" INTEGER NOT NULL DEFAULT 2,
    "approvalCount" INTEGER NOT NULL DEFAULT 0,
    "waitingPeriodEnd" TIMESTAMP(3),
    "payoutReference" TEXT,
    "debitedAmount" INTEGER,
    "createdById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeathClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeathValidation" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeathValidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "reference" TEXT,
    "fundType" TEXT NOT NULL DEFAULT 'operational',
    "status" TEXT NOT NULL DEFAULT 'posted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalPayment" (
    "id" TEXT NOT NULL,
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
    "lastApprovedAt" TIMESTAMP(3),
    "payoutReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchasePoll" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "winnerOptionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PurchasePoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollOption" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "estimatedCost" INTEGER NOT NULL,
    "bankAccountNumber" TEXT,
    "bankCode" TEXT,
    "bankName" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollBallot" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollBallot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuarantorDeduction" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "guarantorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'notified',
    "noticeSentAt" TIMESTAMP(3) NOT NULL,
    "deductAt" TIMESTAMP(3) NOT NULL,
    "deductedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuarantorDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedToId" TEXT,
    "resolution" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "slaDeadline" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grievance" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "response" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Grievance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vote" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "unitId" TEXT,
    "kind" TEXT NOT NULL,
    "electionType" TEXT NOT NULL DEFAULT 'general',
    "position" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "winnerId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "quorumRequired" INTEGER NOT NULL DEFAULT 30,
    "lastResultBroadcastAt" TIMESTAMP(3),

    CONSTRAINT "Vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoteCandidate" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,

    CONSTRAINT "VoteCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoteBallot" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoteBallot_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "Dividend" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "totalPool" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "distributedAt" TIMESTAMP(3),

    CONSTRAINT "Dividend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DividendEntry" (
    "id" TEXT NOT NULL,
    "dividendId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DividendEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'coop',
    "unitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'idle',
    "data" TEXT NOT NULL DEFAULT '{}',
    "lastInboundAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoopPost" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "incumbentId" TEXT,
    "appointedById" TEXT,
    "appointedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoopPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeductionBatch" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalAmount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeductionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeductionItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'savings',
    "loanId" TEXT,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "creditedAt" TIMESTAMP(3),

    CONSTRAINT "DeductionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeductionWaiver" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeductionWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CooperativeConfig" (
    "id" TEXT NOT NULL,
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
    "nextAGMDate" TIMESTAMP(3),
    "lastDividendRate" INTEGER,
    "pendingDividendRate" INTEGER,
    "taxIdentificationNumber" TEXT,
    "cooperativeType" TEXT NOT NULL DEFAULT 'member',
    "commercialIncome" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CooperativeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandingConfig" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "welcomeMessage" TEXT,
    "footerText" TEXT,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "memberLimit" INTEGER NOT NULL DEFAULT 20,
    "monthlyPrice" INTEGER NOT NULL DEFAULT 0,
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataConsent" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Byelaw" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Byelaw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeathClaimApproval" (
    "id" TEXT NOT NULL,
    "deathClaimId" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeathClaimApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "STR" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "filedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "STR_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PAYERecord" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "grossAmount" INTEGER NOT NULL,
    "taxAmount" INTEGER NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "remittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PAYERecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAssistAction" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetMemberId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "metadata" JSONB,
    "otp" TEXT NOT NULL,
    "otpExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,

    CONSTRAINT "AdminAssistAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualCredit" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "narration" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedById" TEXT,
    "rejectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),

    CONSTRAINT "ManualCredit_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "Member_cooperativeId_phone_key" ON "Member"("cooperativeId", "phone");

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
CREATE INDEX "Loan_memberId_status_idx" ON "Loan"("memberId", "status");

-- CreateIndex
CREATE INDEX "Loan_cooperativeId_status_idx" ON "Loan"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "Loan_status_createdAt_idx" ON "Loan"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Guarantor_code_key" ON "Guarantor"("code");

-- CreateIndex
CREATE INDEX "Guarantor_code_idx" ON "Guarantor"("code");

-- CreateIndex
CREATE INDEX "Guarantor_memberId_status_idx" ON "Guarantor"("memberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Guarantor_loanId_memberId_key" ON "Guarantor"("loanId", "memberId");

-- CreateIndex
CREATE INDEX "LoanRepayment_loanId_paidAt_idx" ON "LoanRepayment"("loanId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_reference_key" ON "Payout"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payout_status_createdAt_idx" ON "Payout"("status", "createdAt");

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
CREATE INDEX "Grievance_cooperativeId_status_idx" ON "Grievance"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "Grievance_memberId_idx" ON "Grievance"("memberId");

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
CREATE INDEX "PAYERecord_cooperativeId_year_month_idx" ON "PAYERecord"("cooperativeId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "PAYERecord_cooperativeId_memberId_month_year_key" ON "PAYERecord"("cooperativeId", "memberId", "month", "year");

-- CreateIndex
CREATE INDEX "AdminAssistAction_cooperativeId_status_createdAt_idx" ON "AdminAssistAction"("cooperativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAssistAction_targetMemberId_status_idx" ON "AdminAssistAction"("targetMemberId", "status");

-- CreateIndex
CREATE INDEX "ManualCredit_cooperativeId_status_createdAt_idx" ON "ManualCredit"("cooperativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ManualCredit_memberId_status_idx" ON "ManualCredit"("memberId", "status");

-- AddForeignKey
ALTER TABLE "ReconciliationLog" ADD CONSTRAINT "ReconciliationLog_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReserveAllocation" ADD CONSTRAINT "ReserveAllocation_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EducationFund" ADD CONSTRAINT "EducationFund_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentFund" ADD CONSTRAINT "DevelopmentFund_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_adminMemberId_fkey" FOREIGN KEY ("adminMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_superApproved2ById_fkey" FOREIGN KEY ("superApproved2ById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guarantor" ADD CONSTRAINT "Guarantor_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guarantor" ADD CONSTRAINT "Guarantor_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRepayment" ADD CONSTRAINT "LoanRepayment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Posting" ADD CONSTRAINT "Posting_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoritePayee" ADD CONSTRAINT "FavoritePayee_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberProgress" ADD CONSTRAINT "MemberProgress_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusPost" ADD CONSTRAINT "StatusPost_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathClaim" ADD CONSTRAINT "DeathClaim_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathClaim" ADD CONSTRAINT "DeathClaim_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathValidation" ADD CONSTRAINT "DeathValidation_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "DeathClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathValidation" ADD CONSTRAINT "DeathValidation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalPayment" ADD CONSTRAINT "ExternalPayment_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalPayment" ADD CONSTRAINT "ExternalPayment_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalPayment" ADD CONSTRAINT "ExternalPayment_approved1ById_fkey" FOREIGN KEY ("approved1ById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalPayment" ADD CONSTRAINT "ExternalPayment_approved2ById_fkey" FOREIGN KEY ("approved2ById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalPayment" ADD CONSTRAINT "ExternalPayment_approved3ById_fkey" FOREIGN KEY ("approved3ById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePoll" ADD CONSTRAINT "PurchasePoll_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePoll" ADD CONSTRAINT "PurchasePoll_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollOption" ADD CONSTRAINT "PollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "PurchasePoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollOption" ADD CONSTRAINT "PollOption_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollBallot" ADD CONSTRAINT "PollBallot_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "PurchasePoll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollBallot" ADD CONSTRAINT "PollBallot_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "PollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollBallot" ADD CONSTRAINT "PollBallot_voterId_fkey" FOREIGN KEY ("voterId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuarantorDeduction" ADD CONSTRAINT "GuarantorDeduction_guarantorId_fkey" FOREIGN KEY ("guarantorId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grievance" ADD CONSTRAINT "Grievance_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grievance" ADD CONSTRAINT "Grievance_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grievance" ADD CONSTRAINT "Grievance_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoteCandidate" ADD CONSTRAINT "VoteCandidate_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "Vote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoteCandidate" ADD CONSTRAINT "VoteCandidate_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoteBallot" ADD CONSTRAINT "VoteBallot_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "Vote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoteBallot" ADD CONSTRAINT "VoteBallot_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "VoteCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoteBallot" ADD CONSTRAINT "VoteBallot_voterId_fkey" FOREIGN KEY ("voterId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendVote" ADD CONSTRAINT "DividendVote_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendVote" ADD CONSTRAINT "DividendVote_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendVoteBallot" ADD CONSTRAINT "DividendVoteBallot_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "DividendVote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendVoteBallot" ADD CONSTRAINT "DividendVoteBallot_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dividend" ADD CONSTRAINT "Dividend_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendEntry" ADD CONSTRAINT "DividendEntry_dividendId_fkey" FOREIGN KEY ("dividendId") REFERENCES "Dividend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DividendEntry" ADD CONSTRAINT "DividendEntry_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoopPost" ADD CONSTRAINT "CoopPost_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoopPost" ADD CONSTRAINT "CoopPost_incumbentId_fkey" FOREIGN KEY ("incumbentId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionBatch" ADD CONSTRAINT "DeductionBatch_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionBatch" ADD CONSTRAINT "DeductionBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionBatch" ADD CONSTRAINT "DeductionBatch_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionItem" ADD CONSTRAINT "DeductionItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DeductionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionItem" ADD CONSTRAINT "DeductionItem_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionWaiver" ADD CONSTRAINT "DeductionWaiver_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CooperativeConfig" ADD CONSTRAINT "CooperativeConfig_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandingConfig" ADD CONSTRAINT "BrandingConfig_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataConsent" ADD CONSTRAINT "DataConsent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Byelaw" ADD CONSTRAINT "Byelaw_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathClaimApproval" ADD CONSTRAINT "DeathClaimApproval_deathClaimId_fkey" FOREIGN KEY ("deathClaimId") REFERENCES "DeathClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathClaimApproval" ADD CONSTRAINT "DeathClaimApproval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "STR" ADD CONSTRAINT "STR_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "STR" ADD CONSTRAINT "STR_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PAYERecord" ADD CONSTRAINT "PAYERecord_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PAYERecord" ADD CONSTRAINT "PAYERecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAssistAction" ADD CONSTRAINT "AdminAssistAction_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAssistAction" ADD CONSTRAINT "AdminAssistAction_targetMemberId_fkey" FOREIGN KEY ("targetMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAssistAction" ADD CONSTRAINT "AdminAssistAction_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCredit" ADD CONSTRAINT "ManualCredit_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCredit" ADD CONSTRAINT "ManualCredit_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCredit" ADD CONSTRAINT "ManualCredit_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCredit" ADD CONSTRAINT "ManualCredit_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
