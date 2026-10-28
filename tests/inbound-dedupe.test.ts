import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../tests/setup.js";
import { claimInboundMessage, pruneInboundMessageLog } from "../src/lib/inbound-dedupe.js";

describe("inbound message dedupe", () => {
  beforeEach(async () => {
    await prisma.processedInbound.deleteMany({});
  });

  it("claims a message id exactly once", async () => {
    expect(await claimInboundMessage("whatsapp", "wamid.TEST1")).toBe(true);
    expect(await claimInboundMessage("whatsapp", "wamid.TEST1")).toBe(false);
  });

  it("keeps channels in separate namespaces", async () => {
    expect(await claimInboundMessage("whatsapp", "same-id")).toBe(true);
    expect(await claimInboundMessage("telegram", "same-id")).toBe(true);
  });

  it("prunes log rows older than the retention window", async () => {
    await prisma.processedInbound.create({
      data: {
        id: "stale",
        channel: "whatsapp",
        receivedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.processedInbound.create({ data: { id: "fresh", channel: "whatsapp" } });

    const removed = await pruneInboundMessageLog(30);

    expect(removed).toBe(1);
    expect(await prisma.processedInbound.findUnique({ where: { id: "stale" } })).toBeNull();
    expect(await prisma.processedInbound.findUnique({ where: { id: "fresh" } })).not.toBeNull();
  });
});
