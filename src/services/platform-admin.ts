import { randomInt } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { hashPin } from "../lib/security.js";
import { normalizePhone } from "../lib/phones.js";
import { writePlatformAudit } from "./platform-audit.js";
import type { PlatformActor } from "./platform-coops.js";

/** PlatformAdmin is a global (non-tenant) table, so it is queried directly. */
export interface PlatformAdminView {
  id: string;
  name: string;
  phone: string;
  role: string;
  active: boolean;
  totpEnabled: boolean;
  mustChangePin: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface CreatePlatformAdminInput {
  name: string;
  phone: string;
  role?: string;
}

export interface CreatePlatformAdminResult extends PlatformAdminView {
  /** Plaintext temp PIN — only leaves via the return value (never persisted). */
  tempPin: string;
}

const ROLES = new Set(["owner", "developer", "support"]);

function toView(row: {
  id: string;
  name: string;
  phone: string;
  role: string;
  active: boolean;
  totpEnabled: boolean;
  mustChangePin: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}): PlatformAdminView {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    role: row.role,
    active: row.active,
    totpEnabled: row.totpEnabled,
    mustChangePin: row.mustChangePin,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

export async function listPlatformAdmins(): Promise<PlatformAdminView[]> {
  const rows = await prisma.platformAdmin.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(toView);
}

/** Create a platform admin with a random 4-digit temp PIN (must be changed on first login). */
export async function createPlatformAdmin(
  input: CreatePlatformAdminInput,
  actor?: PlatformActor,
): Promise<CreatePlatformAdminResult> {
  const role = input.role && ROLES.has(input.role) ? input.role : "developer";
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error("invalid phone number");
  const tempPin = String(randomInt(1000, 9000));
  const admin = await prisma.platformAdmin.create({
    data: {
      name: input.name,
      phone,
      role,
      pin: hashPin(tempPin),
      mustChangePin: true,
      createdById: actor?.id ?? null,
    },
  });
  if (actor) {
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "platform_admin.create",
      targetType: "platform_admin",
      targetId: admin.id,
      detail: JSON.stringify({ phone: admin.phone, role: admin.role }),
    });
  }
  return { ...toView(admin), tempPin };
}

/** Update a platform admin's role and/or active flag. */
export async function setPlatformAdmin(
  id: string,
  input: { role?: string; active?: boolean },
  actor?: PlatformActor,
): Promise<PlatformAdminView> {
  if (input.role !== undefined && !ROLES.has(input.role)) {
    throw new Error(`invalid role: ${input.role}`);
  }
  const admin = await prisma.platformAdmin.update({
    where: { id },
    data: {
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.active === undefined ? {} : { active: input.active }),
    },
  });
  if (actor) {
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "platform_admin.update",
      targetType: "platform_admin",
      targetId: admin.id,
      detail: JSON.stringify({ role: input.role, active: input.active }),
    });
  }
  return toView(admin);
}
