import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
}));

const PHONE = "2348012345678";
const ADMIN_PHONE = "2348099999999";
const OTHER_MEMBER = "2348077777777";

async function makeCoop(code: string, name: string, adminPhone?: string) {
  return prisma.cooperative.create({ data: { name, code, adminPhone } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: { role?: string } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  const m = await prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      pin: hashPin("1234"),
      wallet: { create: {} },
    },
  });
  return { ...m, code };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.posting.deleteMany();
  await prisma.journalEntry.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.coopPost.deleteMany();
  await prisma.beneficiary.deleteMany();
  await prisma.pollBallot.deleteMany();
  await prisma.pollOption.deleteMany();
  await prisma.purchasePoll.deleteMany();
  await prisma.externalPayment.deleteMany();
  await prisma.guarantorDeduction.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.voteBallot.deleteMany();
  await prisma.voteCandidate.deleteMany();
  await prisma.vote.deleteMany();
  await prisma.supportTicket.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.deathValidation.deleteMany();
  await prisma.deathClaim.deleteMany();
  await prisma.withdrawalRequest.deleteMany();
  await prisma.contribution.deleteMany();
  await prisma.loanRepayment.deleteMany();
  await prisma.guarantor.deleteMany();
  await prisma.loan.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.dividendEntry.deleteMany();
  await prisma.dividend.deleteMany();
  await prisma.broadcast.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.member.deleteMany();
  await prisma.unit.deleteMany();
  await prisma.cooperative.deleteMany();
  await prisma.session.deleteMany();
});

describe("executive posts", () => {
  it("super admin assigns a post and everyone can view the organogram", async () => {
    const coop = await makeCoop("TESTP1", "Post Coop", ADMIN_PHONE);
    const superM = await makeMember(ADMIN_PHONE, coop.id, { role: "superadmin" });
    const treasurer = await makeMember(PHONE, coop.id);

    await handleMessage(ADMIN_PHONE, `setpost treasurer ${treasurer.code}`);

    let texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text);
    expect(texts.some((t) => t.includes("Treasurer"))).toBe(true);

    const post = await prisma.coopPost.findUnique({
      where: { cooperativeId_title: { cooperativeId: coop.id, title: "treasurer" } },
    });
    expect(post?.incumbentId).toBe(treasurer.id);
    expect(post?.appointedById).toBe(superM.id);

    const audited = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "post.set" },
    });
    expect(audited).not.toBeNull();

    // Any member can view the organogram.
    vi.clearAllMocks();
    await handleMessage(PHONE, "posts");
    texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text);
    expect(texts.some((t) => t.includes("Treasurer") && t.includes(treasurer.name))).toBe(true);
  });

  it("normalises titles so 'Treasurer' and 'treasurer' are one post", async () => {
    const coop = await makeCoop("TESTP2", "Post Coop", ADMIN_PHONE);
    await makeMember(ADMIN_PHONE, coop.id, { role: "superadmin" });
    const a = await makeMember(PHONE, coop.id);

    await handleMessage(ADMIN_PHONE, `setpost Treasurer ${a.code}`);
    await handleMessage(ADMIN_PHONE, `setpost TREASURER ${a.code}`);

    const count = await prisma.coopPost.count({ where: { cooperativeId: coop.id } });
    expect(count).toBe(1);
  });

  it("rejects non-super admins and unknown member codes", async () => {
    const coop = await makeCoop("TESTP3", "Post Coop");
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const target = await makeMember(PHONE, coop.id);

    await handleMessage(ADMIN_PHONE, `setpost treasurer ${target.code}`);
    expect(
      vi.mocked(sendText).mock.calls.map((c) => c[0].text).some((t) => t.includes("super admin")),
    ).toBe(true);
  });

  it("rejects an unknown member code without creating the post", async () => {
    const coop = await makeCoop("TESTP4", "Post Coop", ADMIN_PHONE);
    await makeMember(ADMIN_PHONE, coop.id, { role: "superadmin" });

    await handleMessage(ADMIN_PHONE, `setpost treasurer NOPE00`);

    expect(await prisma.coopPost.count({ where: { cooperativeId: coop.id } })).toBe(0);
    expect(
      vi.mocked(sendText).mock.calls.map((c) => c[0].text).some((t) => t.includes("No member")),
    ).toBe(true);
  });

  it("reassigning a post moves it to the new holder", async () => {
    const coop = await makeCoop("TESTP5", "Post Coop", ADMIN_PHONE);
    await makeMember(ADMIN_PHONE, coop.id, { role: "superadmin" });
    const first = await makeMember(PHONE, coop.id);
    const second = await makeMember(OTHER_MEMBER, coop.id);

    await handleMessage(ADMIN_PHONE, `setpost president ${first.code}`);
    await handleMessage(ADMIN_PHONE, `setpost president ${second.code}`);

    const posts = await prisma.coopPost.findMany({ where: { cooperativeId: coop.id } });
    expect(posts.length).toBe(1);
    expect(posts[0].incumbentId).toBe(second.id);
  });

  it("removepost vacates the seat", async () => {
    const coop = await makeCoop("TESTP6", "Post Coop", ADMIN_PHONE);
    await makeMember(ADMIN_PHONE, coop.id, { role: "superadmin" });
    const holder = await makeMember(PHONE, coop.id);

    await handleMessage(ADMIN_PHONE, `setpost secretary ${holder.code}`);
    await handleMessage(ADMIN_PHONE, `removepost secretary`);

    const post = await prisma.coopPost.findUnique({
      where: { cooperativeId_title: { cooperativeId: coop.id, title: "secretary" } },
    });
    expect(post?.incumbentId).toBeNull();

    await handleMessage(PHONE, "posts");
    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text);
    expect(texts.some((t) => t.toLowerCase().includes("vacant"))).toBe(true);
  });
});
