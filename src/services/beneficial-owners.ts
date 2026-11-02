import { prisma } from "../lib/prisma.js";

/** A rejected beneficial-ownership change. Maps to a plain chat error. */
export class BeneficialOwnerError extends Error {}

const TOTAL_TOLERANCE = 0.001;

function cleanName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 160) {
    throw new BeneficialOwnerError("Beneficial owner name must be 2-160 characters.");
  }
  return name;
}

function cleanRcNumber(value: string): string {
  const rc = value.trim().toUpperCase().replace(/\s+/g, " ");
  if (!/^(RC)?[ -]?\d{3,12}$/.test(rc)) {
    throw new BeneficialOwnerError("RC number must look like RC1234567 or 1234567.");
  }
  return rc;
}

async function requireMember(cooperativeId: string, code: string) {
  const member = await prisma.member.findFirst({
    where: { cooperativeId, code: code.trim().toUpperCase() },
  });
  if (!member) throw new BeneficialOwnerError(`No member with code *${code}* in this cooperative.`);
  return member;
}

/** Mark a member as a corporate body and record its CAC RC number. */
export async function markCorporateMember(cooperativeId: string, code: string, rcNumber: string) {
  const member = await requireMember(cooperativeId, code);
  const rc = cleanRcNumber(rcNumber);
  return prisma.member.update({
    where: { id: member.id },
    data: { entityType: "corporate", rcNumber: rc },
  });
}

export async function addBeneficialOwner(
  cooperativeId: string,
  code: string,
  name: string,
  ownershipPct: number,
  idType?: string | null,
  idNumber?: string | null,
) {
  const member = await requireMember(cooperativeId, code);
  if (member.entityType !== "corporate") {
    throw new BeneficialOwnerError(
      `*${member.code}* is an individual member. Run *corporate ${member.code} <RC number>* first.`,
    );
  }
  const ownerName = cleanName(name);
  if (!Number.isFinite(ownershipPct) || ownershipPct <= 0 || ownershipPct > 100) {
    throw new BeneficialOwnerError("Ownership percentage must be greater than 0 and at most 100.");
  }

  const existing = await prisma.memberBeneficialOwner.findMany({
    where: { cooperativeId, memberId: member.id },
    select: { ownershipPct: true, name: true },
  });
  const total = existing.reduce((sum, row) => sum + row.ownershipPct, 0);
  if (total + ownershipPct > 100 + TOTAL_TOLERANCE) {
    throw new BeneficialOwnerError(
      `Adding ${ownershipPct}% would exceed 100%. Already recorded: ${total}%.`,
    );
  }
  if (existing.some((row) => row.name.toLowerCase() === ownerName.toLowerCase())) {
    throw new BeneficialOwnerError(`*${ownerName}* is already recorded as a beneficial owner.`);
  }

  return prisma.memberBeneficialOwner.create({
    data: {
      cooperativeId,
      memberId: member.id,
      name: ownerName,
      ownershipPct,
      idType: idType?.trim() || null,
      idNumber: idNumber?.trim() || null,
    },
  });
}

export async function listBeneficialOwners(cooperativeId: string, code: string) {
  const member = await requireMember(cooperativeId, code);
  const owners = await prisma.memberBeneficialOwner.findMany({
    where: { cooperativeId, memberId: member.id },
    orderBy: { ownershipPct: "desc" },
  });
  const total = owners.reduce((sum, row) => sum + row.ownershipPct, 0);
  return { member, owners, total: Math.round(total * 100) / 100 };
}

/**
 * Remove a beneficial owner by full id or unambiguous 6-character suffix.
 * Scoped to the member so one cooperative can never touch another's records.
 */
export async function removeBeneficialOwner(cooperativeId: string, code: string, ownerRef: string) {
  const member = await requireMember(cooperativeId, code);
  const ref = ownerRef.trim();
  if (!ref) throw new BeneficialOwnerError("Usage: *removebeneficial <member code> <owner id>*");

  const matches = await prisma.memberBeneficialOwner.findMany({
    where: {
      cooperativeId,
      memberId: member.id,
      OR: [{ id: ref }, { id: { endsWith: ref } }],
    },
  });
  if (matches.length === 0) throw new BeneficialOwnerError("No matching beneficial owner found.");
  if (matches.length > 1) {
    throw new BeneficialOwnerError(
      "That reference matches more than one owner — use more characters.",
    );
  }
  await prisma.memberBeneficialOwner.delete({ where: { id: matches[0].id } });
  return matches[0];
}
