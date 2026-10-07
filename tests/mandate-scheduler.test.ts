/**
 * Task 5: scheduler savings auto-debit + retries + reminder suppression.
 *
 * The scheduler drives the provider through the app-wide payments mock in
 * tests/setup.ts, so we re-arm `resolveProvider` with a fake adapter (the same
 * pattern used by tests/mandates.test.ts).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import {
  runMandateDebits,
  runMandateRetries,
  runAutoSaveReminders,
} from "../src/services/scheduler.js";
import { resolveProvider } from "../src/services/payments/index.js";
import { notifyMember } from "../src/lib/messaging.js";

/** A fake provider adapter exposing only what the scheduler calls. */
function fakeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    name: "monnify",
    debitMandate: vi.fn(async () => ({ ok: true, providerRef: "TRX-1", status: "SUCCESSFUL" })),
    verifyWebhook: () => true,
    parseNotification: () => null,
    ...overrides,
  } as never;
}

async function enableDirectDebit(coopId: string) {
  await prisma.cooperativeConfig.upsert({
    where: { cooperativeId: coopId },
    create: { cooperativeId: coopId, directDebitEnabled: true },
    update: { directDebitEnabled: true },
  });
}

async function setAutoSave(memberId: string, amount: number, due: Date) {
  await prisma.member.update({
    where: { id: memberId },
    data: {
      autoSaveEnabled: true,
      autoSaveAmount: amount,
      autoSaveInterval: "monthly",
      autoSaveNextDue: due,
    },
  });
}

async function seedMandate(
  coopId: string,
  memberId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.mandate.create({
    data: {
      cooperativeId: coopId,
      memberId,
      provider: "monnify",
      providerMandateId: "MTDD|X",
      providerReference: `MAN-${Math.random().toString(36).slice(2)}`,
      status: "active",
      amountCap: 100_000,
      bankAccountNumber: "0123456789",
      bankCode: "044",
      ...overrides,
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

afterAll(cleanupDatabase);

describe("mandate scheduler debits", () => {
  it("creates a pending savings debit capped by the mandate and calls the provider", async () => {
    const coop = await createTestCoop("MSCH1");
    const m = await createTestMember(coop.id, { phone: "2348000300001" });
    await enableDirectDebit(coop.id);
    await setAutoSave(m.id, 300_000, new Date(Date.now() - 1000));
    const mandate = await seedMandate(coop.id, m.id, { amountCap: 100_000 });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    const debit = await prisma.mandateDebit.findFirst({ where: { mandateId: mandate.id } });
    expect(debit).toBeTruthy();
    expect(debit?.status).toBe("pending");
    expect(debit?.purpose).toBe("savings");
    expect(debit?.amount).toBe(100_000);
    expect(n).toBe(1);

    expect(vi.mocked(adapter.debitMandate)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(adapter.debitMandate).mock.calls[0][0] as {
      amount: number;
      narration?: string;
    };
    expect(call.amount).toBe(100_000);
    expect(call.narration).toMatch(/savings/i);
  });

  it("skips a paused mandate entirely", async () => {
    const coop = await createTestCoop("MSCH5");
    const m = await createTestMember(coop.id, { phone: "2348000300005" });
    await enableDirectDebit(coop.id);
    await setAutoSave(m.id, 50_000, new Date(Date.now() - 1000));
    await seedMandate(coop.id, m.id, { status: "paused" });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    expect(await prisma.mandateDebit.count()).toBe(0);
    expect(n).toBe(0);
  });

  it("skips a purpose listed in pausedPurposes", async () => {
    const coop = await createTestCoop("MSCH6");
    const m = await createTestMember(coop.id, { phone: "2348000300006" });
    await enableDirectDebit(coop.id);
    await setAutoSave(m.id, 50_000, new Date(Date.now() - 1000));
    await seedMandate(coop.id, m.id, { pausedPurposes: "savings" });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    expect(await prisma.mandateDebit.count()).toBe(0);
    expect(n).toBe(0);
  });
});

describe("mandate scheduler retries", () => {
  it("retries a due failed debit and advances nextRetryAt by one day", async () => {
    const coop = await createTestCoop("MSCH4");
    const m = await createTestMember(coop.id, { phone: "2348000300004" });
    const mandate = await seedMandate(coop.id, m.id);
    const debit = await prisma.mandateDebit.create({
      data: {
        mandateId: mandate.id,
        cooperativeId: coop.id,
        memberId: m.id,
        purpose: "savings",
        amount: 50_000,
        status: "failed",
        providerRef: "DD-FAILED-1",
        nextRetryAt: new Date(Date.now() - 60_000),
      },
    });
    const adapter = fakeAdapter({
      debitMandate: vi.fn(async () => ({ ok: false, error: "still failing" })),
    });
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const now = new Date();
    const n = await runMandateRetries(now);

    expect(vi.mocked(adapter.debitMandate)).toHaveBeenCalledTimes(1);
    const row = await prisma.mandateDebit.findUnique({ where: { id: debit.id } });
    expect(row?.status).toBe("failed");
    const retry = row!.nextRetryAt!.getTime();
    expect(retry).toBeGreaterThanOrEqual(now.getTime() + 23 * 60 * 60 * 1000);
    expect(retry).toBeLessThanOrEqual(now.getTime() + 25 * 60 * 60 * 1000);
    expect(n).toBe(1);
  });

  it("never selects a skipped debit for retry", async () => {
    const coop = await createTestCoop("MSCH7");
    const m = await createTestMember(coop.id, { phone: "2348000300007" });
    const mandate = await seedMandate(coop.id, m.id);
    const debit = await prisma.mandateDebit.create({
      data: {
        mandateId: mandate.id,
        cooperativeId: coop.id,
        memberId: m.id,
        purpose: "savings",
        amount: 50_000,
        status: "skipped",
        providerRef: "DD-SKIP-1",
        nextRetryAt: new Date(Date.now() - 60_000),
      },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateRetries(new Date());

    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    expect((await prisma.mandateDebit.findUnique({ where: { id: debit.id } }))?.status).toBe(
      "skipped",
    );
    expect(n).toBe(0);
  });
});

describe("auto-save reminder suppression", () => {
  it("does not send a reminder to a member with an active mandate", async () => {
    const coop = await createTestCoop("MSCH2");
    const m = await createTestMember(coop.id, { phone: "2348000300002" });
    await setAutoSave(m.id, 50_000, new Date(Date.now() - 1000));
    await seedMandate(coop.id, m.id);
    vi.mocked(notifyMember).mockClear();

    await runAutoSaveReminders(new Date());

    const sentToMember = vi
      .mocked(notifyMember)
      .mock.calls.some((c) => (c[0] as { phone?: string }).phone === m.phone);
    expect(sentToMember).toBe(false);
  });

  it("still sends a reminder to a member without a mandate", async () => {
    const coop = await createTestCoop("MSCH3");
    const m = await createTestMember(coop.id, { phone: "2348000300003" });
    await setAutoSave(m.id, 50_000, new Date(Date.now() - 1000));
    vi.mocked(notifyMember).mockClear();

    await runAutoSaveReminders(new Date());

    const sentToMember = vi
      .mocked(notifyMember)
      .mock.calls.some((c) => (c[0] as { phone?: string }).phone === m.phone);
    expect(sentToMember).toBe(true);
  });
});
