import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { savePayee, listPayees, resolvePayee, deletePayee } from "../src/lib/beneficiaries.js";
import { isFrozen } from "../src/lib/freeze.js";
import { formatBalance } from "../src/lib/money.js";
import { sendText } from "../src/lib/messaging.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { handleMessage } from "../src/services/conversation.js";
import { handleAnalytics, handleBalance } from "../src/services/handlers/money.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

const PHONE = "2348099887766";

function lastText(): string {
  const calls = vi.mocked(sendText).mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as { text: string }).text : "";
}

beforeEach(async () => {
  try {
    await prisma.$executeRaw`DELETE FROM loan`;
  } catch {}
  try {
    await prisma.$executeRaw`DELETE FROM contribution`;
  } catch {}
  try {
    await prisma.$executeRaw`DELETE FROM favoritePayee`;
  } catch {}
  try {
    await prisma.$executeRaw`DELETE FROM wallet`;
  } catch {}
  try {
    await prisma.$executeRaw`DELETE FROM member`;
  } catch {}
  try {
    await prisma.$executeRaw`DELETE FROM cooperative`;
  } catch {}
  clearMemberCache();
  vi.mocked(sendText).mockClear();
});

async function makeCoopAndMember() {
  const coop = await prisma.cooperative.upsert({
    where: { code: "XRA01" },
    update: { dailyPayoutLimit: 5000000 },
    create: { name: "Xara Test Coop", code: "XRA01", dailyPayoutLimit: 5000000 },
  });
  const existingMember = await prisma.member.findFirst({ where: { phone: PHONE } });
  let member = existingMember;
  if (!member) {
    member = await prisma.member.create({
      data: {
        cooperativeId: coop.id,
        phone: PHONE,
        name: "Test User",
        code: generateMemberCode(),
        role: "member",
        status: "active",
        consentAt: new Date(),
        pin: hashPin("1234"),
        wallet: { create: {} },
      },
    });
  }
  return { coop, member };
}

describe("Favorite Payees (Beneficiary Memory)", () => {
  it("savePayee creates a payee and listPayees returns it", async () => {
    const { member } = await makeCoopAndMember();
    const result = await savePayee(member.id, "Mama Ngozi", "0123456789", "044", "GTBank");
    expect(result.ok).toBe(true);
    const payees = await listPayees(member.id);
    expect(payees).toHaveLength(1);
    expect(payees[0].name).toBe("mama ngozi");
  });

  it("resolvePayee finds by name fuzzy match", async () => {
    const { member } = await makeCoopAndMember();
    await savePayee(member.id, "Mama Ngozi", "0123456789", "044", "GTBank");
    const found = await resolvePayee(member.id, "mama");
    expect(found).not.toBeNull();
    expect(found!.accountNumber).toBe("0123456789");
  });

  it("resolvePayee finds by index", async () => {
    const { member } = await makeCoopAndMember();
    await savePayee(member.id, "Mama Ngozi", "0123456789", "044", "GTBank");
    await savePayee(member.id, "Chuks", "0987654321", "033", "Access");
    // listPayees is most-recently-used first, so the newest save is index 1.
    const found = await resolvePayee(member.id, "1");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("chuks");
  });

  it("deletePayee removes a payee", async () => {
    const { member } = await makeCoopAndMember();
    const saved = await savePayee(member.id, "Mama Ngozi", "0123456789", "044", "GTBank");
    const deleted = await deletePayee(member.id, saved.payee!.id);
    expect(deleted.ok).toBe(true);
    const payees = await listPayees(member.id);
    expect(payees).toHaveLength(0);
  });
});

describe("Self-serve account freeze", () => {
  it("freeze and unfreeze commands toggle the member's frozen state", async () => {
    const { member } = await makeCoopAndMember();
    expect((await isFrozen(member.id)).frozen).toBe(false);

    await handleMessage(PHONE, "freeze");
    clearMemberCache();
    const frozen = await prisma.member.findUnique({
      where: { id: member.id },
      select: { frozenAt: true },
    });
    expect(frozen?.frozenAt).not.toBeNull();
    expect((await isFrozen(member.id)).frozen).toBe(true);

    await handleMessage(PHONE, "unfreeze");
    clearMemberCache();
    const thawed = await prisma.member.findUnique({
      where: { id: member.id },
      select: { frozenAt: true },
    });
    expect(thawed?.frozenAt).toBeNull();
    expect((await isFrozen(member.id)).frozen).toBe(false);
  });

  it("a supervisory freeze wins and the member cannot lift it", async () => {
    const { member } = await makeCoopAndMember();
    await prisma.member.update({
      where: { id: member.id },
      data: { supervisoryFrozenAt: new Date() },
    });
    clearMemberCache();

    const guard = await isFrozen(member.id);
    expect(guard.frozen).toBe(true);
    expect(guard.frozen ? guard.message : "").toMatch(/supervisory/i);

    await handleMessage(PHONE, "unfreeze");
    clearMemberCache();
    const still = await prisma.member.findUnique({
      where: { id: member.id },
      select: { supervisoryFrozenAt: true, frozenAt: true },
    });
    expect(still?.supervisoryFrozenAt).not.toBeNull();
    expect((await isFrozen(member.id)).frozen).toBe(true);
  });
});

describe("Spending analytics", () => {
  it("reports balance, all-time savings, this-month savings and active loans", async () => {
    const { coop, member } = await makeCoopAndMember();
    await prisma.wallet.update({
      where: { memberId: member.id },
      data: { balance: 250000, totalSaved: 400000 },
    });
    await prisma.contribution.create({
      data: {
        amount: 150000,
        reference: "XRA-ANALYTICS-1",
        status: "confirmed",
        paidAt: new Date(),
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });
    await prisma.loan.create({
      data: {
        amount: 500000,
        balance: 300000,
        status: "disbursed",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });
    vi.mocked(sendText).mockClear();

    await handleAnalytics(PHONE, {
      id: member.id,
      name: member.name,
      cooperativeId: coop.id,
      wallet: { balance: 250000, totalSaved: 400000 },
    });

    const text = lastText();
    expect(text).toContain("Savings analytics");
    expect(text).toContain(formatBalance(250000));
    expect(text).toContain(formatBalance(400000));
    expect(text).toContain(formatBalance(150000));
    expect(text).toContain("Active loans: *1*");
    expect(text).toContain(formatBalance(300000));
  });
});

describe("Enriched confirmations", () => {
  it("balance includes the outstanding loan balance", async () => {
    const { coop, member } = await makeCoopAndMember();
    await prisma.loan.create({
      data: {
        amount: 500000,
        balance: 300000,
        status: "disbursed",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });
    vi.mocked(sendText).mockClear();

    await handleBalance(PHONE, {
      id: member.id,
      name: member.name,
      cooperative: { name: coop.name },
      wallet: { balance: 250000 },
    });

    const text = lastText();
    expect(text).toContain("Outstanding loan balance");
    expect(text).toContain(formatBalance(300000));
  });
});
