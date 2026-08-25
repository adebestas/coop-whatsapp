import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { savePayee, listPayees, resolvePayee, deletePayee } from "../src/lib/beneficiaries.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

const PHONE = "2348099887766";

beforeEach(async () => {
  try { await prisma.$executeRaw`DELETE FROM favoritePayee`; } catch {}
  try { await prisma.$executeRaw`DELETE FROM wallet`; } catch {}
  try { await prisma.$executeRaw`DELETE FROM member`; } catch {}
  try { await prisma.$executeRaw`DELETE FROM cooperative`; } catch {}
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
    const found = await resolvePayee(member.id, "2");
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
