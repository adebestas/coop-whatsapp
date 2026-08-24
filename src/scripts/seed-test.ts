/**
 * Database seed script with test data.
 * Usage: npx tsx src/scripts/seed-test.ts
 *
 * Creates:
 * - 1 cooperative (TEST01)
 * - 1 superadmin
 * - 1 admin
 * - 5 members with wallets
 * - Sample contributions, loans, and withdrawals
 */
import { prisma } from "../lib/prisma.js";
import { generateMemberCode, hashPin } from "../lib/security.js";

const COOP_CODE = "TEST01";
const ADMIN_PHONE = "2348012345678";
const SUPERADMIN_PHONE = "2348098765432";
const TEST_PIN = "1234";

const MEMBERS = [
  { name: "Alice Adewale", phone: "2348011111111", role: "superadmin" as const },
  { name: "Bob Bakare", phone: "2348022222222", role: "admin" as const },
  { name: "Carol Chukwu", phone: "2348033333333", role: "member" as const },
  { name: "David Dangana", phone: "2348044444444", role: "member" as const },
  { name: "Eva Eze", phone: "2348055555555", role: "member" as const },
];

async function seed() {
  console.log("🌱 Seeding database...");

  // Create cooperative
  const coop = await prisma.cooperative.upsert({
    where: { code: COOP_CODE },
    create: {
      name: "Test Cooperative",
      code: COOP_CODE,
      state: "Lagos",
      adminPhone: ADMIN_PHONE,
    },
    update: { name: "Test Cooperative", state: "Lagos", adminPhone: ADMIN_PHONE },
  });
  console.log(`✅ Cooperative: ${coop.name} (${coop.code})`);

  // Create superadmin
  await createMember(coop.id, {
    name: "Super Admin",
    phone: SUPERADMIN_PHONE,
    role: "superadmin",
  });
  console.log(`✅ Superadmin: ${SUPERADMIN_PHONE}`);

  // Create admin
  await createMember(coop.id, {
    name: "Admin User",
    phone: ADMIN_PHONE,
    role: "admin",
  });
  console.log(`✅ Admin: ${ADMIN_PHONE}`);

  // Create test members
  for (const member of MEMBERS) {
    await createMember(coop.id, member);
    console.log(`✅ Member: ${member.name} (${member.phone})`);
  }

  // Create sample contributions
  const members = await prisma.member.findMany({
    where: { cooperativeId: coop.id },
    include: { wallet: true },
  });

  for (const member of members.slice(2)) {
    if (member.wallet) {
      await prisma.contribution.create({
        data: {
          memberId: member.id,
          cooperativeId: coop.id,
          amount: 5000,
          type: "savings",
          reference: `SEED-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
      });
      await prisma.wallet.update({
        where: { id: member.wallet.id },
        data: { balance: { increment: 5000 } },
      });
    }
  }
  console.log("✅ Sample contributions created");

  console.log("\n🎉 Seed complete!");
  console.log(`\nTest cooperative code: ${COOP_CODE}`);
  console.log(`Admin phone: ${ADMIN_PHONE}`);
  console.log(`PIN: ${TEST_PIN}`);
}

async function createMember(
  coopId: string,
  data: { name: string; phone: string; role: "member" | "admin" | "superadmin" },
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }

  return prisma.member.upsert({
    where: { cooperativeId_phone: { cooperativeId: coopId, phone: data.phone } },
    create: {
      name: data.name,
      phone: data.phone,
      code,
      pin: hashPin(TEST_PIN),
      role: data.role,
      cooperativeId: coopId,
      wallet: { create: {} },
    },
    update: { role: data.role, name: data.name },
  });
}

seed()
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
