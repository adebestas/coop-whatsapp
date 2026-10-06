import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember } from "./setup.js";
import { allocateByShares, buyShares, getShareAccount } from "../src/services/shares.js";

async function fundWallet(memberId: string, kobo: number) {
  await prisma.wallet.update({ where: { memberId }, data: { balance: kobo, totalSaved: kobo } });
}

describe("share capital", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await prisma.shareTransaction.deleteMany();
    await prisma.shareAccount.deleteMany();
    await prisma.posting.deleteMany();
    await prisma.journalEntry.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperative.deleteMany();
  });

  it("allocates a pool by shareholding with no kobo lost", () => {
    const holdings = [
      { id: "a", shares: 1 },
      { id: "b", shares: 1 },
      { id: "c", shares: 1 },
    ];
    const out = allocateByShares(holdings, 100);
    const total = [...out.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(100);
    expect(out.get("a")).toBeGreaterThanOrEqual(33);
  });

  it("buys shares from the wallet and posts a balanced journal", async () => {
    const coop = await createTestCoop("SHARE1");
    const member = await createTestMember(coop.id, { phone: "2348000000001" });
    await fundWallet(member.id, 500000); // ₦5,000

    const result = await buyShares(member.id, 3); // 3 × ₦1,000 = ₦3,000
    expect(result.ok).toBe(true);

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares).toBe(3);
    expect(account?.totalPaid).toBe(300000);

    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(200000); // ₦5,000 − ₦3,000

    const postings = await prisma.posting.findMany();
    const debit = postings.filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount, 0);
    const credit = postings.filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount, 0);
    expect(debit).toBe(credit);
    expect(postings.some((p) => p.account === "equity:share_capital")).toBe(true);
  });

  it("refuses a purchase the wallet cannot cover", async () => {
    const coop = await createTestCoop("SHARE2");
    const member = await createTestMember(coop.id, { phone: "2348000000002" });
    await fundWallet(member.id, 50000); // ₦500

    const result = await buyShares(member.id, 1); // costs ₦1,000
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/save/i);
    expect(await prisma.shareAccount.findFirst({ where: { memberId: member.id } })).toBeNull();
  });

  it("reports the share account value", async () => {
    const coop = await createTestCoop("SHARE3");
    const member = await createTestMember(coop.id, { phone: "2348000000003" });
    await fundWallet(member.id, 500000);
    await buyShares(member.id, 2);

    const account = await getShareAccount(member.id);
    expect(account?.shares).toBe(2);
    expect(account?.value).toBe(200000);
  });
});

import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";

describe("shares chat commands", () => {
  it("buys shares via the chat command", async () => {
    const coop = await createTestCoop("SHARECHAT");
    const member = await createTestMember(coop.id, { phone: "2348000000099" });
    await fundWallet(member.id, 500000);

    await handleMessage(member.phone, "buyshares 2");
    await handleMessage(member.phone, "1234");

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares).toBe(2);
    const calls = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(calls).toMatch(/share/i);
  });

  it("does not buy shares on a wrong PIN", async () => {
    const coop = await createTestCoop("SHARECHAT2");
    const member = await createTestMember(coop.id, { phone: "2348000000098" });
    await fundWallet(member.id, 500000);

    await handleMessage(member.phone, "buyshares 2");
    await handleMessage(member.phone, "0000");

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares ?? 0).toBe(0);
  });
});
