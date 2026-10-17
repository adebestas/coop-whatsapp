import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

const SUPER_PHONE = "2348022222222";
const M1 = "2348033333333";
const NEW = "2348099999999";

async function makeCoop(code: string, name: string, adminPhone?: string) {
  return prisma.cooperative.create({ data: { name, code, adminPhone } });
}

async function makeMember(phone: string, coopId: string, opts: { role?: string } = {}) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      pin: hashPin("1234"),
      wallet: { create: {} },
      consentAt: new Date(),
    },
    include: { wallet: true },
  });
}

function texts() {
  return [
    ...vi.mocked(sendText).mock.calls.map((c) => c[0].text),
    ...vi.mocked(notifyMember).mock.calls.map((c) => String(c[1])),
  ].join("\n");
}

/** Pull the 6-digit OTP that was sent to a given number out of the sendText mock. */
function otpFor(to: string): string | null {
  for (const c of vi.mocked(sendText).mock.calls) {
    if (c[0].to === to) {
      const m = String(c[0].text).match(/code is \*(\d{6})\*/);
      if (m) return m[1];
    }
  }
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

describe("member-initiated phone change", () => {
  it("OTP-verifies the new number, then a super admin approval applies the switch", async () => {
    const coop = await makeCoop("PHN01", "Phone Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const m = await makeMember(M1, coop.id);

    await handleMessage(M1, `changephone ${NEW}`);
    expect(texts()).toContain("sent a 6-digit code");
    const code = otpFor(NEW);
    expect(code).not.toBeNull();

    // Wrong code is rejected and the flow stays open.
    await handleMessage(M1, "000000");
    expect(texts()).toContain("Wrong code");

    // Correct code opens a pending approval request.
    await handleMessage(M1, code!);
    const req = await prisma.phoneChangeRequest.findFirst({ where: { memberId: m.id } });
    expect(req!.status).toBe("pending_approval");
    expect(req!.newPhone).toBe(NEW);
    expect(
      vi
        .mocked(notifyMember)
        .mock.calls.map((c) => String(c[1]))
        .join("\n"),
    ).toContain("approvephone");

    // Super approves -> the switch is applied.
    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `approvephone ${m.code}`);
    const moved = await prisma.member.findUnique({ where: { id: m.id } });
    expect(moved!.phone).toBe(NEW);
    expect(
      (await prisma.phoneChangeRequest.findFirst({ where: { memberId: m.id } }))!.status,
    ).toBe("approved");
    expect(
      await prisma.auditLog.findFirst({ where: { action: "account.phone.change.approve" } }),
    ).not.toBeNull();

    // The old number can no longer act as the member.
    await handleMessage(M1, "balance");
    expect(texts().toLowerCase()).toContain("join a cooperative first");
  });

  it("a super admin can reject a pending change", async () => {
    const coop = await makeCoop("PHN02", "Reject Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const m = await makeMember(M1, coop.id);

    await handleMessage(M1, `changephone ${NEW}`);
    const code = otpFor(NEW)!;
    await handleMessage(M1, code);

    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `rejectphone ${m.code} not the account holder`);
    expect(
      (await prisma.phoneChangeRequest.findFirst({ where: { memberId: m.id } }))!.status,
    ).toBe("rejected");
    const still = await prisma.member.findUnique({ where: { id: m.id } });
    expect(still!.phone).toBe(M1);
    expect(
      await prisma.auditLog.findFirst({ where: { action: "account.phone.change.reject" } }),
    ).not.toBeNull();
  });

  it("refuses a number already linked to another member", async () => {
    const coop = await makeCoop("PHN03", "Clash Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    await makeMember(M1, coop.id);
    await makeMember(NEW, coop.id);

    await handleMessage(M1, `changephone ${NEW}`);
    expect(texts()).toContain("already linked to another member");
    expect(await prisma.phoneChangeRequest.count()).toBe(0);
  });
});
