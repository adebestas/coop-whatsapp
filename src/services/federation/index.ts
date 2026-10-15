import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit.js";

export async function createFederation(name: string, code: string, baseCurrency: string) {
  return prisma.federation.create({ data: { name, code, baseCurrency } });
}

export async function addMember(federationId: string, cooperativeId: string) {
  const existing = await prisma.federationMembership.findUnique({
    where: { federationId_cooperativeId: { federationId, cooperativeId } },
  });
  if (existing) return existing;
  const m = await prisma.federationMembership.create({
    data: { federationId, cooperativeId, status: "active" },
  });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.member.add",
    targetType: "federation",
    targetId: federationId,
    detail: `coop ${cooperativeId} joined federation ${federationId}`,
  });
  return m;
}

export async function removeMember(federationId: string, cooperativeId: string): Promise<void> {
  await prisma.federationMembership.deleteMany({ where: { federationId, cooperativeId } });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.member.remove",
    targetType: "federation",
    targetId: federationId,
    detail: `coop ${cooperativeId} left federation ${federationId}`,
  });
}

export async function listFederationsForCoop(cooperativeId: string) {
  const memberships = await prisma.federationMembership.findMany({
    where: { cooperativeId, status: "active" },
    include: { federation: true },
  });
  return memberships.map((m) => m.federation);
}
