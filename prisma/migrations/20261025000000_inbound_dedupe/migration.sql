-- Idempotency log for inbound channel messages (WhatsApp webhook retries and
-- Telegram at-least-once polling). Platform-level: no cooperativeId, no RLS.
CREATE TABLE "ProcessedInbound" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedInbound_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProcessedInbound_receivedAt_idx" ON "ProcessedInbound"("receivedAt");
