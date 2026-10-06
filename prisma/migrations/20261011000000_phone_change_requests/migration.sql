-- =============================================================================
-- PhoneChangeRequest: member-initiated, OTP-verified, admin-approved channel change
-- =============================================================================

CREATE TABLE "PhoneChangeRequest" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "oldPhone" TEXT NOT NULL,
    "newPhone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "PhoneChangeRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PhoneChangeRequest_cooperativeId_status_idx" ON "PhoneChangeRequest"("cooperativeId", "status");
CREATE INDEX "PhoneChangeRequest_memberId_idx" ON "PhoneChangeRequest"("memberId");

ALTER TABLE "PhoneChangeRequest" ADD CONSTRAINT "PhoneChangeRequest_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PhoneChangeRequest" ADD CONSTRAINT "PhoneChangeRequest_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
