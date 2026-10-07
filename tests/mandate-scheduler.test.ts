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
  reconcileStaleMandateDebits,
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

  it("fail-closes a Paystack debit when the mandate has no authorization code yet", async () => {
    const coop = await createTestCoop("MSCHPS1");
    const m = await createTestMember(coop.id, { phone: "2348000300091" });
    await enableDirectDebit(coop.id);
    await setAutoSave(m.id, 50_000, new Date(Date.now() - 1000));
    await seedMandate(coop.id, m.id, {
      provider: "paystack",
      providerMandateId: null,
      status: "active",
    });
    const adapter = fakeAdapter({ name: "paystack" });
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    await runMandateDebits(new Date());

    // The provider must never be called without a resolved authorization code.
    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    const debit = await prisma.mandateDebit.findFirst();
    expect(debit?.status).toBe("failed");
    expect(debit?.failureReason).toMatch(/not activated|authorization code/i);
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

  it("creates only one debit when the same due obligation is processed twice (overlapping ticks)", async () => {
    const coop = await createTestCoop("MSCH8");
    const m = await createTestMember(coop.id, { phone: "2348000300008" });
    await enableDirectDebit(coop.id);
    const due = new Date(Date.now() - 1000);
    await setAutoSave(m.id, 50_000, due);
    const mandate = await seedMandate(coop.id, m.id);
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const now = new Date();
    await runMandateDebits(now);
    // Simulate an overlapping tick that read the STALE (pre-advance) member row.
    await prisma.member.update({ where: { id: m.id }, data: { autoSaveNextDue: due } });
    await runMandateDebits(now);

    expect(await prisma.mandateDebit.count({ where: { mandateId: mandate.id } })).toBe(1);
    expect(vi.mocked(adapter.debitMandate)).toHaveBeenCalledTimes(1);
  });

  it("continues to the next mandate when one mandate's debit persistence fails", async () => {
    const coop = await createTestCoop("MSCH9");
    const a = await createTestMember(coop.id, { phone: "2348000300009" });
    const b = await createTestMember(coop.id, { phone: "2348000300010" });
    await enableDirectDebit(coop.id);
    await setAutoSave(a.id, 50_000, new Date(Date.now() - 1000));
    await setAutoSave(b.id, 50_000, new Date(Date.now() - 1000));
    await seedMandate(coop.id, a.id);
    await seedMandate(coop.id, b.id);
    // Remove one member so its mandate's related-member load fails mid-job.
    // The loop must catch that per-mandate failure and carry on to the other.
    await prisma.member.delete({ where: { id: b.id } });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    expect(n).toBe(1);
    expect(await prisma.mandateDebit.count()).toBe(1);
    expect(vi.mocked(adapter.debitMandate)).toHaveBeenCalledTimes(1);
  });

  it("creates a loan debit for the full overdue charge (installment + late fine)", async () => {
    const coop = await createTestCoop("MSCH10");
    const m = await createTestMember(coop.id, { phone: "2348000300011" });
    await enableDirectDebit(coop.id);
    const mandate = await seedMandate(coop.id, m.id, { amountCap: 200_000 });
    const loan = await prisma.loan.create({
      data: {
        amount: 500_000,
        balance: 250_000,
        monthlyPayment: 100_000,
        tenureMonths: 1,
        status: "disbursed",
        dueDate: new Date(Date.now() - 1000),
        memberId: m.id,
        cooperativeId: coop.id,
      },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    const debit = await prisma.mandateDebit.findFirst({
      where: { mandateId: mandate.id, purpose: "loan" },
    });
    expect(debit).toBeTruthy();
    expect(debit?.status).toBe("pending");
    expect(debit?.targetId).toBe(loan.id);
    // Full charge = installment 100_000 + 5% late fine (one month overdue).
    expect(debit?.amount).toBe(105_000);
    expect(n).toBe(1);

    const call = vi.mocked(adapter.debitMandate).mock.calls[0][0] as {
      amount: number;
      narration?: string;
    };
    expect(call.amount).toBe(105_000);
    expect(call.narration).toMatch(/loan/i);
  });

  it("skips an overdue loan whose full charge exceeds the mandate cap and notifies the member", async () => {
    const coop = await createTestCoop("MSCH11");
    const m = await createTestMember(coop.id, { phone: "2348000300012" });
    await enableDirectDebit(coop.id);
    const mandate = await seedMandate(coop.id, m.id, { amountCap: 100_000 });
    await prisma.loan.create({
      data: {
        amount: 300_000,
        balance: 300_000,
        monthlyPayment: 300_000,
        tenureMonths: 1,
        status: "disbursed",
        dueDate: new Date(Date.now() - 1000),
        memberId: m.id,
        cooperativeId: coop.id,
      },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);
    vi.mocked(notifyMember).mockClear();

    const n = await runMandateDebits(new Date());

    // Never create a partial debit: the full charge (315_000) exceeds the cap.
    expect(await prisma.mandateDebit.count({ where: { mandateId: mandate.id } })).toBe(0);
    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    expect(n).toBe(0);
    const told = vi
      .mocked(notifyMember)
      .mock.calls.some((c) => /cap|installment/i.test(String(c[1])));
    expect(told).toBe(true);
  });

  it("creates only one loan debit when the same due obligation is processed twice", async () => {
    const coop = await createTestCoop("MSCH12");
    const m = await createTestMember(coop.id, { phone: "2348000300013" });
    await enableDirectDebit(coop.id);
    const mandate = await seedMandate(coop.id, m.id, { amountCap: 200_000 });
    await prisma.loan.create({
      data: {
        amount: 100_000,
        balance: 100_000,
        monthlyPayment: 50_000,
        tenureMonths: 1,
        status: "disbursed",
        dueDate: new Date(Date.now() - 1000),
        memberId: m.id,
        cooperativeId: coop.id,
      },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const now = new Date();
    await runMandateDebits(now);
    await runMandateDebits(now);

    expect(await prisma.mandateDebit.count({ where: { mandateId: mandate.id } })).toBe(1);
    expect(vi.mocked(adapter.debitMandate)).toHaveBeenCalledTimes(1);
  });

  it("does not create a loan debit when loan is a paused purpose", async () => {
    const coop = await createTestCoop("MSCH13");
    const m = await createTestMember(coop.id, { phone: "2348000300014" });
    await enableDirectDebit(coop.id);
    await seedMandate(coop.id, m.id, { pausedPurposes: "loan" });
    await prisma.loan.create({
      data: {
        amount: 100_000,
        balance: 100_000,
        monthlyPayment: 50_000,
        tenureMonths: 1,
        status: "disbursed",
        dueDate: new Date(Date.now() - 1000),
        memberId: m.id,
        cooperativeId: coop.id,
      },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    expect(await prisma.mandateDebit.count({ where: { purpose: "loan" } })).toBe(0);
    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });
});

/** Seed an active ROSCA group with a single open cycle. */
async function seedGroup(
  coopId: string,
  createdById: string,
  overrides: { contributionAmount?: number; code?: string; cycleStatus?: string } = {},
) {
  const group = await prisma.group.create({
    data: {
      cooperativeId: coopId,
      type: "rosca",
      name: "Harvest ROSCA",
      code: overrides.code ?? `G${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      contributionAmount: overrides.contributionAmount ?? 200_000,
      cycleLength: 5,
      createdById,
    },
  });
  const cycle = await prisma.groupCycle.create({
    data: {
      groupId: group.id,
      cooperativeId: coopId,
      cycleNumber: 1,
      status: overrides.cycleStatus ?? "open",
    },
  });
  return { group, cycle };
}

describe("mandate scheduler group contributions", () => {
  it("creates a group debit for an active membership with an unfulfilled open cycle", async () => {
    const coop = await createTestCoop("MSCH14");
    const m = await createTestMember(coop.id, { phone: "2348000300015" });
    await enableDirectDebit(coop.id);
    const mandate = await seedMandate(coop.id, m.id, { amountCap: 300_000 });
    const { group } = await seedGroup(coop.id, m.id, { contributionAmount: 200_000 });
    await prisma.groupMember.create({
      data: { groupId: group.id, memberId: m.id, active: true, rotationPosition: 1 },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    const debit = await prisma.mandateDebit.findFirst({
      where: { mandateId: mandate.id, purpose: "group" },
    });
    expect(debit).toBeTruthy();
    expect(debit?.status).toBe("pending");
    expect(debit?.targetId).toBe(group.id);
    expect(debit?.amount).toBe(200_000);
    expect(n).toBe(1);

    const call = vi.mocked(adapter.debitMandate).mock.calls[0][0] as {
      amount: number;
      narration?: string;
      reference?: string;
    };
    expect(call.amount).toBe(200_000);
    expect(call.narration).toMatch(/group/i);
    expect(call.reference).toContain(`DD-${mandate.id}-group-${group.id}`);
  });

  it("does not create a group debit when the member already contributed this cycle", async () => {
    const coop = await createTestCoop("MSCH15");
    const m = await createTestMember(coop.id, { phone: "2348000300016" });
    await enableDirectDebit(coop.id);
    const mandate = await seedMandate(coop.id, m.id, { amountCap: 300_000 });
    const { group, cycle } = await seedGroup(coop.id, m.id);
    await prisma.groupMember.create({
      data: { groupId: group.id, memberId: m.id, active: true, rotationPosition: 1 },
    });
    await prisma.groupContribution.create({
      data: { groupId: group.id, cycleId: cycle.id, memberId: m.id, amount: 200_000 },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    expect(await prisma.mandateDebit.count({ where: { purpose: "group" } })).toBe(0);
    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("skips a group contribution above the mandate cap and notifies the member", async () => {
    const coop = await createTestCoop("MSCH16");
    const m = await createTestMember(coop.id, { phone: "2348000300017" });
    await enableDirectDebit(coop.id);
    const mandate = await seedMandate(coop.id, m.id, { amountCap: 100_000 });
    const { group } = await seedGroup(coop.id, m.id, { contributionAmount: 200_000 });
    await prisma.groupMember.create({
      data: { groupId: group.id, memberId: m.id, active: true, rotationPosition: 1 },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);
    vi.mocked(notifyMember).mockClear();

    const n = await runMandateDebits(new Date());

    expect(await prisma.mandateDebit.count({ where: { mandateId: mandate.id } })).toBe(0);
    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    expect(n).toBe(0);
    const told = vi
      .mocked(notifyMember)
      .mock.calls.some((c) => /cap|contribution/i.test(String(c[1])));
    expect(told).toBe(true);
  });

  it("does not create a group debit when group is a paused purpose", async () => {
    const coop = await createTestCoop("MSCH17");
    const m = await createTestMember(coop.id, { phone: "2348000300018" });
    await enableDirectDebit(coop.id);
    await seedMandate(coop.id, m.id, { pausedPurposes: "group" });
    const { group } = await seedGroup(coop.id, m.id);
    await prisma.groupMember.create({
      data: { groupId: group.id, memberId: m.id, active: true, rotationPosition: 1 },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    expect(await prisma.mandateDebit.count({ where: { purpose: "group" } })).toBe(0);
    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("creates only one group debit when the same open cycle is processed twice", async () => {
    const coop = await createTestCoop("MSCH18");
    const m = await createTestMember(coop.id, { phone: "2348000300019" });
    await enableDirectDebit(coop.id);
    const mandate = await seedMandate(coop.id, m.id, { amountCap: 300_000 });
    const { group } = await seedGroup(coop.id, m.id);
    await prisma.groupMember.create({
      data: { groupId: group.id, memberId: m.id, active: true, rotationPosition: 1 },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const now = new Date();
    await runMandateDebits(now);
    await runMandateDebits(now);

    expect(await prisma.mandateDebit.count({ where: { mandateId: mandate.id } })).toBe(1);
    expect(vi.mocked(adapter.debitMandate)).toHaveBeenCalledTimes(1);
  });

  it("ignores a group membership whose group has no open cycle", async () => {
    const coop = await createTestCoop("MSCH19");
    const m = await createTestMember(coop.id, { phone: "2348000300020" });
    await enableDirectDebit(coop.id);
    const mandate = await seedMandate(coop.id, m.id, { amountCap: 300_000 });
    const { group } = await seedGroup(coop.id, m.id, { cycleStatus: "closed" });
    await prisma.groupMember.create({
      data: { groupId: group.id, memberId: m.id, active: true, rotationPosition: 1 },
    });
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateDebits(new Date());

    expect(await prisma.mandateDebit.count({ where: { mandateId: mandate.id } })).toBe(0);
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

  it("fail-closes a Paystack retry when the mandate has no authorization code yet", async () => {
    const coop = await createTestCoop("MSCHPS2");
    const m = await createTestMember(coop.id, { phone: "2348000300092" });
    const mandate = await seedMandate(coop.id, m.id, {
      provider: "paystack",
      providerMandateId: null,
    });
    const debit = await prisma.mandateDebit.create({
      data: {
        mandateId: mandate.id,
        cooperativeId: coop.id,
        memberId: m.id,
        purpose: "savings",
        amount: 50_000,
        status: "failed",
        providerRef: "DD-PS-FAILED-1",
        nextRetryAt: new Date(Date.now() - 60_000),
      },
    });
    const adapter = fakeAdapter({ name: "paystack" });
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const n = await runMandateRetries(new Date());

    expect(vi.mocked(adapter.debitMandate)).not.toHaveBeenCalled();
    expect(
      (await prisma.mandateDebit.findUnique({ where: { id: debit.id } }))?.status,
    ).toBe("failed");
    expect(n).toBe(0);
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

  it("issues only one provider debit when two retries overlap", async () => {
    const coop = await createTestCoop("MSCH20");
    const m = await createTestMember(coop.id, { phone: "2348000300021" });
    const mandate = await seedMandate(coop.id, m.id);
    await prisma.mandateDebit.create({
      data: {
        mandateId: mandate.id,
        cooperativeId: coop.id,
        memberId: m.id,
        purpose: "savings",
        amount: 50_000,
        status: "failed",
        providerRef: "DD-RACE-1",
        nextRetryAt: new Date(Date.now() - 60_000),
      },
    });

    // Hold the provider call open so BOTH ticks definitely reach it before
    // either writes its post-call state — reproducing the overlap a fast
    // provider would otherwise hide.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const adapter = fakeAdapter({
      debitMandate: vi.fn(async () => {
        await gate;
        return { ok: true, providerRef: "TRX-1", status: "SUCCESSFUL" };
      }),
    });
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const now = new Date();
    const first = runMandateRetries(now);
    const second = runMandateRetries(now);
    // Let both ticks read the failed row and attempt their claim.
    await new Promise((r) => setTimeout(r, 100));
    release();
    await Promise.all([first, second]);

    // The atomic claim lets exactly one tick proceed to the provider.
    expect(vi.mocked(adapter.debitMandate)).toHaveBeenCalledTimes(1);
  });
});

describe("mandate scheduler stale-pending reconciliation", () => {
  it("ages a stale pending debit out to failed so it can be retried", async () => {
    const coop = await createTestCoop("MSCH21");
    const m = await createTestMember(coop.id, { phone: "2348000300022" });
    const mandate = await seedMandate(coop.id, m.id);
    const stale = await prisma.mandateDebit.create({
      data: {
        mandateId: mandate.id,
        cooperativeId: coop.id,
        memberId: m.id,
        purpose: "savings",
        amount: 50_000,
        status: "pending",
        providerRef: "DD-STALE-1",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const fresh = await prisma.mandateDebit.create({
      data: {
        mandateId: mandate.id,
        cooperativeId: coop.id,
        memberId: m.id,
        purpose: "savings",
        amount: 50_000,
        status: "pending",
        providerRef: "DD-FRESH-1",
      },
    });

    const n = await reconcileStaleMandateDebits(new Date());

    const staleRow = await prisma.mandateDebit.findUnique({ where: { id: stale.id } });
    expect(staleRow?.status).toBe("failed");
    expect(staleRow?.nextRetryAt).toBeInstanceOf(Date);
    expect(staleRow?.failureReason).toMatch(/stale|unconfirmed|no webhook/i);
    expect((await prisma.mandateDebit.findUnique({ where: { id: fresh.id } }))?.status).toBe(
      "pending",
    );
    expect(n).toBe(1);
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
