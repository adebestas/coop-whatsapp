-- Inbound messages that failed after their dedupe claim was taken.
-- The claim row is released so provider retries can re-process the message;
-- this table keeps the failure visible (and is pruned after 30 days).
CREATE TABLE "WebhookFailure" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "messageId" TEXT,
    "phone" TEXT,
    "error" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookFailure_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookFailure_createdAt_idx" ON "WebhookFailure"("createdAt");
