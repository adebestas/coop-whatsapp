import { describe, expect, it } from "vitest";

import { prisma } from "./setup.js";
import {
  claimInboundMessage,
  releaseInboundClaim,
  pruneInboundMessageLog,
} from "../src/lib/inbound-dedupe.js";
import {
  recordWebhookFailure,
  pruneWebhookFailures,
} from "../src/lib/webhook-failures.js";

describe("inbound failure handling", () => {
  it("releases a claim so a failed message can be retried", async () => {
    const id = "wa-fail-1";
    expect(await claimInboundMessage("whatsapp", id)).toBe(true);
    expect(await claimInboundMessage("whatsapp", id)).toBe(false);

    await releaseInboundClaim("whatsapp", id);

    // The provider retry must be able to claim the message again — otherwise a
    // handler crash silently loses the member's message forever.
    expect(await claimInboundMessage("whatsapp", id)).toBe(true);
  });

  it("records a durable failure row and prunes old ones", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await prisma.webhookFailure.create({
      data: {
        channel: "whatsapp",
        messageId: "old-1",
        phone: "2348097000011",
        error: "boom",
        createdAt: old,
      },
    });

    await recordWebhookFailure({
      channel: "whatsapp",
      messageId: "wa-fail-2",
      phone: "2348097000012",
      error: "handler exploded",
    });

    const row = await prisma.webhookFailure.findFirst({
      where: { messageId: "wa-fail-2" },
    });
    expect(row?.error).toContain("handler exploded");
    expect(row?.phone).toBe("2348097000012");

    const removed = await pruneWebhookFailures(30);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.webhookFailure.findFirst({ where: { messageId: "old-1" } })).toBeNull();
    expect(await prisma.webhookFailure.findFirst({ where: { messageId: "wa-fail-2" } })).toBeTruthy();
  });

  it("caps stored error text so a stack trace cannot bloat the row", async () => {
    await recordWebhookFailure({
      channel: "telegram",
      messageId: "tg-1",
      error: "x".repeat(5000),
    });
    const row = await prisma.webhookFailure.findFirst({ where: { messageId: "tg-1" } });
    expect(row!.error.length).toBeLessThanOrEqual(1000);
  });
});
