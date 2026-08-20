/**
 * Seed a cooperative and an admin member.
 * Usage: npx tsx src/seed.ts --name "Oyo Farmers Coop" --code OYOF1 --state Oyo --admin-name "Ade Ade" --admin-phone 2348012345678 --admin-pin 1234
 */
import { prisma } from "./lib/prisma.js";
import { generateMemberCode, hashPin } from "./lib/security.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg("name");
  const coopCode = arg("code");
  const state = arg("state");
  const adminName = arg("admin-name");
  const adminPhone = arg("admin-phone")?.replace(/[^0-9]/g, "");
  const adminPin = arg("admin-pin");
  const unitName = arg("unit-name");
  const unitCode = arg("unit-code");

  if (!name || !coopCode || !adminName || !adminPhone || !adminPin) {
    console.error(
      "Usage: npx tsx src/seed.ts --name <name> --code <code> [--state <state>] --admin-name <name> --admin-phone <phone> --admin-pin <pin>",
    );
    process.exit(1);
  }

  const coop = await prisma.cooperative.upsert({
    where: { code: coopCode },
    create: { name, code: coopCode, state, adminPhone },
    update: { name, state, adminPhone },
  });

  const existing = await prisma.member.findUnique({
    where: { cooperativeId_phone: { cooperativeId: coop.id, phone: adminPhone } },
  });
  let memberCode = existing?.code ?? generateMemberCode();
  if (!existing) {
    while (await prisma.member.findUnique({ where: { code: memberCode } })) {
      memberCode = generateMemberCode();
    }
  }

  await prisma.member.upsert({
    where: { cooperativeId_phone: { cooperativeId: coop.id, phone: adminPhone } },
    create: {
      name: adminName,
      phone: adminPhone,
      code: memberCode,
      pin: hashPin(adminPin),
      role: "admin",
      cooperativeId: coop.id,
      wallet: { create: {} },
    },
    update: { role: "admin", name: adminName },
  });

  if (unitName && unitCode) {
    await prisma.unit.upsert({
      where: { cooperativeId_code: { cooperativeId: coop.id, code: unitCode.toUpperCase() } },
      create: { name: unitName, code: unitCode.toUpperCase(), cooperativeId: coop.id },
      update: { name: unitName },
    });
    console.log(`Created workplace "${unitName}" (${unitCode}).`);
  }

  console.log(`Created cooperative "${coop.name}" (${coopCode}) with admin ${adminName} (${adminPhone}, code ${memberCode}).`);
  await prisma.$disconnect();
}

void main();