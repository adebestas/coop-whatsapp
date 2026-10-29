import { prisma } from "./prisma.js";

/**
 * Claim an inbound channel message id. Returns true the first time a message is
 * seen and false for a duplicate delivery (Meta retry, Telegram re-poll).
 */
export async function claimInboundMessage(channel: string, messageId: string): Promise<boolean> {
  const id = `${channel}:${messageId}`;
  // Fast path avoids a guaranteed constraint violation (and its error log) on retries.
  if (await prisma.processedInbound.findUnique({ where: { id }, select: { id: true } })) {
    return false;
  }
  try {
    await prisma.processedInbound.create({ data: { id, channel } });
    return true;
  } catch (err) {
    // Concurrent delivery of the same message: the unique key is the arbiter.
    if ((err as { code?: string })?.code === "P2002") return false;
    throw err;
  }
}

/**
 * Release a claim after processing failed, so the provider's retry (or a manual
 * replay) is not mistaken for a duplicate. Without this, a handler crash loses
 * the message permanently: the claim exists, but no side effect ever happened.
 *
 * NOTE: there is a narrow race where a concurrent retry of the same message
 * already claimed the id successfully BEFORE this release runs. In that case
 * `deleteMany` removes the retry's valid claim, and the retry would be processed
 * again if it is retried a third time. This is acceptable because:
 *  - Per-user mutex serialises processing for the same phone, so concurrent
 *    deliveries of the same message id are extremely rare.
 *  - The alternative (not releasing) silently drops the message forever.
 *  - Money paths are idempotent on the journal txRef, so a rare double-process
 *    is a no-op at the money layer even if it gets through.
 */
export async function releaseInboundClaim(channel: string, messageId: string): Promise<void> {
  await prisma.processedInbound.deleteMany({ where: { id: `${channel}:${messageId}` } });
}

/** Delete dedupe rows older than `retentionDays`; returns the number removed. */
export async function pruneInboundMessageLog(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const res = await prisma.processedInbound.deleteMany({ where: { receivedAt: { lt: cutoff } } });
  return res.count;
}
