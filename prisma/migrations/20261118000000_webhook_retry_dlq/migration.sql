-- Durable retry / dead-letter support for provider webhooks.
--
-- A delivery that was signature-verified but failed to process used to rely
-- entirely on the provider retrying. If the provider gives up, or its retry
-- lands while the DB is still unavailable, the money never reaches the wallet.
-- Keeping the raw body lets OUR retry worker replay the exact delivery with
-- exponential backoff, and `deadAt` marks the point where alerts must fire.

ALTER TABLE "WebhookEvent"
  ADD COLUMN "endpoint" TEXT,
  ADD COLUMN "payload" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deadAt" TIMESTAMP(3);

CREATE INDEX "WebhookEvent_status_nextAttemptAt_idx"
  ON "WebhookEvent" ("status", "nextAttemptAt");
