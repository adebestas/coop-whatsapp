import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { prisma, cleanupDatabase } from "./setup.js";
import {
  WEBHOOK_BASE_DELAY_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_DELAY_MS,
  scheduleWebhookFailure,
  webhookBackoffMs,
} from "../src/lib/webhook-dlq.js";
import { replayStoredWebhook, retryDueWebhookEvents } from "../src/services/webhooks.js";

const PAYLOAD = JSON.stringify({ event: "charge.success", data: { reference: "TOPUP-DLQ-1" } });

beforeEach(async () => {
  await cleanupDatabase();
});

async function seedFailedEvent(id = "paystack:DLQ-1") {
  return prisma.webhookEvent.create({
    data: {
      id,
      provider: "paystack",
      kind: "credit",
      payloadHash: createHash("sha256").update(PAYLOAD).digest("hex"),
      status: "failed",
      endpoint: "credit",
      payload: PAYLOAD,
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 1000),
    },
  });
}

describe("webhook backoff", () => {
  it("starts at five minutes and doubles, capped at six hours", () => {
    expect(webhookBackoffMs(1)).toBe(WEBHOOK_BASE_DELAY_MS);
    expect(webhookBackoffMs(2)).toBe(WEBHOOK_BASE_DELAY_MS * 2);
    expect(webhookBackoffMs(3)).toBe(WEBHOOK_BASE_DELAY_MS * 4);
    expect(webhookBackoffMs(4)).toBe(WEBHOOK_BASE_DELAY_MS * 8);
    expect(webhookBackoffMs(20)).toBe(WEBHOOK_MAX_DELAY_MS);
    expect(webhookBackoffMs(0)).toBe(WEBHOOK_BASE_DELAY_MS);
  });

  it("never exceeds the cap even for absurd attempt counts", () => {
    for (const attempt of [8, 9, 12, 1000]) {
      expect(webhookBackoffMs(attempt)).toBeLessThanOrEqual(WEBHOOK_MAX_DELAY_MS);
    }
  });
});

describe("dead-letter handling", () => {
  it("records the payload, bumps attempts and schedules the next retry", async () => {
    await seedFailedEvent();

    await scheduleWebhookFailure({
      eventId: "paystack:DLQ-1",
      provider: "paystack",
      kind: "credit",
      endpoint: "credit",
      payload: PAYLOAD,
      error: new Error("db unavailable"),
    });

    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: "paystack:DLQ-1" } });
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    expect(row.error).toContain("db unavailable");
    expect(row.deadAt).toBeNull();
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
  });

  it("moves to dead after the retry budget is exhausted and stops scheduling", async () => {
    await seedFailedEvent("paystack:DLQ-2");

    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      await scheduleWebhookFailure({
        eventId: "paystack:DLQ-2",
        provider: "paystack",
        kind: "credit",
        endpoint: "credit",
        payload: PAYLOAD,
        error: new Error(`attempt ${i + 1} failed`),
      });
    }

    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: "paystack:DLQ-2" } });
    expect(row.status).toBe("dead");
    expect(row.deadAt).not.toBeNull();
    expect(row.nextAttemptAt).toBeNull();
    expect(row.attempts).toBeGreaterThanOrEqual(WEBHOOK_MAX_ATTEMPTS);
  });

  it("never resurrects or re-alerts a dead delivery", async () => {
    await seedFailedEvent("paystack:DLQ-8");
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      await scheduleWebhookFailure({
        eventId: "paystack:DLQ-8",
        provider: "paystack",
        endpoint: "credit",
        payload: PAYLOAD,
        error: new Error("boom"),
      });
    }
    const dead = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: "paystack:DLQ-8" } });

    await scheduleWebhookFailure({
      eventId: "paystack:DLQ-8",
      provider: "paystack",
      endpoint: "credit",
      payload: PAYLOAD,
      error: new Error("late arrival"),
    });

    const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: "paystack:DLQ-8" } });
    expect(after.status).toBe("dead");
    expect(after.attempts).toBe(dead.attempts);
    expect(after.deadAt?.getTime()).toBe(dead.deadAt?.getTime());
  });

  it("leaves a missing row alone instead of throwing into the webhook response", async () => {
    await expect(
      scheduleWebhookFailure({
        eventId: "paystack:does-not-exist",
        provider: "paystack",
        kind: "credit",
        endpoint: "credit",
        payload: PAYLOAD,
        error: new Error("record failed"),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("replay", () => {
  it("replays a due delivery and closes it once the body is handled", async () => {
    await seedFailedEvent("paystack:DLQ-3");

    await replayStoredWebhook("paystack:DLQ-3");

    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: "paystack:DLQ-3" } });
    // The payload is not a credit this platform can apply, so the body is
    // acknowledged ("ignored") and the row must leave the retry queue.
    expect(row.status).toBe("processed");
    expect(row.nextAttemptAt).toBeNull();
  });

  it("does nothing for processed or dead rows", async () => {
    await prisma.webhookEvent.create({
      data: {
        id: "paystack:DLQ-4",
        provider: "paystack",
        kind: "credit",
        payloadHash: "x",
        status: "processed",
        endpoint: "credit",
        payload: PAYLOAD,
      },
    });
    const before = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: "paystack:DLQ-4" } });
    await replayStoredWebhook("paystack:DLQ-4");
    const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: "paystack:DLQ-4" } });
    expect(after).toEqual(before);
  });

  it("skips rows that are not due yet", async () => {
    await prisma.webhookEvent.create({
      data: {
        id: "paystack:DLQ-5",
        provider: "paystack",
        kind: "credit",
        payloadHash: "x",
        status: "failed",
        endpoint: "credit",
        payload: PAYLOAD,
        nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await replayStoredWebhook("paystack:DLQ-5");
    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: "paystack:DLQ-5" } });
    expect(row.status).toBe("failed");
  });

  it("sweeps only due rows", async () => {
    await seedFailedEvent("paystack:DLQ-6");
    await prisma.webhookEvent.create({
      data: {
        id: "paystack:DLQ-7",
        provider: "paystack",
        kind: "credit",
        payloadHash: "x",
        status: "failed",
        endpoint: "credit",
        payload: PAYLOAD,
        nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const replayed = await retryDueWebhookEvents();

    expect(replayed).toBe(1);
    const swept = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: "paystack:DLQ-6" } });
    const untouched = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: "paystack:DLQ-7" },
    });
    expect(swept.status).toBe("processed");
    expect(untouched.status).toBe("failed");
  });
});
