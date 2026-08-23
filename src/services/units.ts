import { prisma } from "../lib/prisma.js";
import { notifyMember } from "../lib/messaging.js";

/** Coop admin creates a workplace/unit. */
export async function createUnit(
  adminPhone: string,
  name: string,
  code: string,
): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({ where: { phone: adminPhone, role: "admin" } });
  if (!admin) return { ok: false, message: "Only a cooperative admin can create units." };

  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(normalized)) {
    return { ok: false, message: "Unit code must be 2–10 letters/numbers, e.g. *LAG01*." };
  }
  const existing = await prisma.unit.findUnique({
    where: { cooperativeId_code: { cooperativeId: admin.cooperativeId, code: normalized } },
  });
  if (existing) {
    return { ok: false, message: `A unit with code *${normalized}* already exists.` };
  }

  await prisma.unit.create({
    data: { name: name.trim(), code: normalized, cooperativeId: admin.cooperativeId },
  });
  return { ok: true, message: `Unit *${name.trim()}* (${normalized}) created. Members can join with *joinunit ${normalized}*.` };
}

/** Assign a unit admin using a member code. */
export async function setUnitAdmin(
  adminPhone: string,
  unitCode: string,
  memberCode: string,
): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({
    where: { phone: adminPhone, role: { in: ["admin", "superadmin"] } },
  });
  if (!admin) return { ok: false, message: "Only a cooperative admin can assign unit admins." };

  const unit = await prisma.unit.findUnique({
    where: { cooperativeId_code: { cooperativeId: admin.cooperativeId, code: unitCode.trim().toUpperCase() } },
  });
  if (!unit) return { ok: false, message: `No unit with code *${unitCode}* in your cooperative.` };

  const member = await prisma.member.findFirst({
    where: { cooperativeId: admin.cooperativeId, code: memberCode.trim().toUpperCase() },
  });
  if (!member) return { ok: false, message: `No member with code *${memberCode}* in your cooperative.` };

  await prisma.$transaction([
    prisma.unit.update({ where: { id: unit.id }, data: { adminMemberId: member.id } }),
    prisma.member.update({ where: { id: member.id }, data: { role: "admin" } }),
  ]);
  return {
    ok: true,
    message: `${member.name} is now the admin of *${unit.name}* (${unit.code}).`,
  };
}

/** Member joins a unit by its code. */
export async function joinUnit(phone: string, code: string): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({ where: { phone } });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }
  const unit = await prisma.unit.findUnique({
    where: { cooperativeId_code: { cooperativeId: member.cooperativeId, code: code.trim().toUpperCase() } },
  });
  if (!unit) {
    return { ok: false, message: `No workplace with code *${code}* in your cooperative. Ask your admin for the code.` };
  }
  if (member.unitId === unit.id) {
    return { ok: false, message: `You're already in *${unit.name}*.` };
  }
  await prisma.member.update({ where: { id: member.id }, data: { unitId: unit.id } });
  return { ok: true, message: `You're now part of *${unit.name}* (${unit.code}).` };
}

/** List units for an admin. */
export async function listUnits(phone: string): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({ where: { phone, role: "admin" } });
  if (!admin) return { ok: false, message: "Only admins can list units." };

  const units = await prisma.unit.findMany({
    where: { cooperativeId: admin.cooperativeId },
    include: { adminMember: true, _count: { select: { members: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (units.length === 0) {
    return { ok: false, message: "No workplaces yet. Create one with *addunit <name> <code>*." };
  }
  const body = units
    .map(
      (u) =>
        `• *${u.code}* — ${u.name} — ${u._count.members} members — admin: ${
          u.adminMember?.name ?? "none (use *unitadmin <code> <membercode>* to set)"
        }`,
    )
    .join("\n");
  return { ok: true, message: `*Workplaces in your cooperative*\n\n${body}` };
}

/** The unit-scoped admin of a member, if any. */
export async function unitAdminOf(member: { id: string }): Promise<{ unit: { id: string; name: string }; admin: { id: string } } | null> {
  const unit = await prisma.unit.findFirst({ where: { adminMemberId: member.id } });
  if (!unit) return null;
  return { unit: { id: unit.id, name: unit.name }, admin: { id: member.id } };
}

/** Send a message to every member of a scope (unit or whole coop). */
export async function broadcastToScope(opts: {
  senderPhone: string;
  message: string;
  scope: "coop" | "unit";
}): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({ where: { phone: opts.senderPhone, role: "admin" } });
  if (!admin) return { ok: false, message: "Only admins can broadcast." };

  let unitId: string | null = null;
  let unitName = "";
  if (opts.scope === "unit") {
    const unit = await unitAdminOf(admin);
    if (!unit) {
      return { ok: false, message: "You're not the admin of any workplace. Broadcast to the whole coop instead." };
    }
    unitId = unit.unit.id;
    unitName = unit.unit.name;
  }

  const members = await prisma.member.findMany({
    where: { cooperativeId: admin.cooperativeId, ...(unitId ? { unitId } : {}) },
  });
  if (members.length === 0) {
    return { ok: false, message: "No members to broadcast to yet." };
  }

  const banner = opts.scope === "unit" ? `📢 *${unitName}*` : "📢 *Cooperative announcement*";
  const text = `${banner}\n\n${opts.message}\n\n— ${admin.name}`;

  await prisma.broadcast.create({
    data: {
      cooperativeId: admin.cooperativeId,
      senderId: admin.id,
      senderName: admin.name,
      message: opts.message,
      scope: opts.scope,
      unitId,
    },
  });

  await Promise.all(members.map((m) => notifyMember(m, text)));
  return { ok: true, message: `Message sent to ${members.length} member(s) ✅` };
}