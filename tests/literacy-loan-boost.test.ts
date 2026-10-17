import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../tests/setup.js";
import { applyForLoan, LOAN_TO_SAVINGS_RATIO } from "../src/services/loans.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { updateCoopConfig } from "../src/services/coop-config.js";

const SAVINGS = 5_000_000; // ₦50,000 in kobo

async function makeCoop(code: string) {
  return prisma.cooperative.create({
    data: { name: `Coop ${code}`, code, adminPhone: "2348000000000" },
  });
}

async function makeMember(coopId: string, phone: string, totalSaved: number) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      pin: hashPin("1234"),
      consentAt: new Date(),
      wallet: { create: { balance: totalSaved, totalSaved } },
    },
  });
}

async function giveCert(coopId: string, memberId: string, revoked = false) {
  return prisma.literacyCertificate.create({
    data: {
      cooperativeId: coopId,
      memberId,
      referenceCode: `CERT-TST-${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
      score: 6,
      totalQuestions: 6,
      ...(revoked ? { revokedAt: new Date() } : {}),
    },
  });
}

describe("certified loan-limit boost", () => {
  beforeEach(async () => {
    await prisma.literacyCertificate.deleteMany();
    await prisma.loan.deleteMany();
    await prisma.memberProgress.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperativeConfig.deleteMany();
    await prisma.cooperative.deleteMany();
  });

  it("keeps the base cap for a non-certified member", async () => {
    const coop = await makeCoop("BOOST1");
    const member = await makeMember(coop.id, "2348013330001", SAVINGS);
    const baseMax = SAVINGS * LOAN_TO_SAVINGS_RATIO;

    const over = await applyForLoan(member.phone, baseMax + 1, 3);
    expect(over.ok).toBe(false);

    const atCap = await applyForLoan(member.phone, baseMax, 3);
    expect(atCap.ok).toBe(true);
  });

  it("raises the cap for a certified member", async () => {
    const coop = await makeCoop("BOOST2");
    const member = await makeMember(coop.id, "2348013330002", SAVINGS);
    await giveCert(coop.id, member.id);

    // 2.5x — above the base 2x, within the boosted 3x.
    const boosted = await applyForLoan(member.phone, Math.floor(SAVINGS * 2.5), 3);
    expect(boosted.ok).toBe(true);
  });

  it("does not boost when the coop disables certification", async () => {
    const coop = await makeCoop("BOOST3");
    await updateCoopConfig(coop.id, { literacyCertificationEnabled: false });
    const member = await makeMember(coop.id, "2348013330003", SAVINGS);
    await giveCert(coop.id, member.id);

    const baseMax = SAVINGS * LOAN_TO_SAVINGS_RATIO;
    const over = await applyForLoan(member.phone, baseMax + 1, 3);
    expect(over.ok).toBe(false);
  });

  it("does not boost when the certificate is revoked", async () => {
    const coop = await makeCoop("BOOST4");
    const member = await makeMember(coop.id, "2348013330004", SAVINGS);
    await giveCert(coop.id, member.id, true);

    const baseMax = SAVINGS * LOAN_TO_SAVINGS_RATIO;
    const over = await applyForLoan(member.phone, baseMax + 1, 3);
    expect(over.ok).toBe(false);
  });
});
