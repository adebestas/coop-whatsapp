/**
 * Seed a cooperative and an admin member.
 * Usage: npx tsx src/seed.ts --name "Oyo Farmers Coop" --code OYOF1 --state Oyo --admin-name "Ade Ade" --admin-phone 2348012345678 --admin-pin 1234
 */
import { prisma } from "./lib/prisma.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg("name");
  const code = arg("code");
  const state = arg("state");
  const adminName = arg("admin-name");
  const adminPhone = arg("admin-phone")?.replace(/[^0-9]/g, "");
  const adminPin = arg("admin-pin");

  if (!name || !code || !adminName || !adminPhone || !adminPin) {
    console.error(
      "Usage: npx tsx src/seed.ts --name <name> --code <code> [--state <state>] --admin-name <name> --admin-phone <phone> --admin-pin <pin>",
    );
    process.exit(1);
  }

  const coop = await prisma.cooperative.upsert({
    where: { code },
    create: { name, code, state, adminPhone },
    update: { name, state, adminPhone },
  });

  await prisma.member.upsert({
    where: { cooperativeId_phone: { cooperativeId: coop.id, phone: adminPhone } },
    create: {
      name: adminName,
      phone: adminPhone,
      pin: adminPin,
      role: "admin",
      cooperativeId: coop.id,
      wallet: { create: {} },
    },
    update: { role: "admin", name: adminName },
  });

  console.log(`Created cooperative "${coop.name}" (${coop.code}) with admin ${adminName} (${adminPhone}).`);
  await prisma.$disconnect();
}

void main();