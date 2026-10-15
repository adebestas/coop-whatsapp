import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  createFederation,
  addMember,
  removeMember,
  listFederationsForCoop,
} from "../src/services/federation/index.js";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `Coop ${code}`, code, currency: "NGN" } });
}

describe("federation membership", () => {
  it("creates a federation and adds/removes members", async () => {
    const fed = await createFederation("West Africa Fed", `FED${Date.now()}`, "NGN");
    const coop = await makeCoop(`C${Date.now()}`);
    await addMember(fed.id, coop.id);
    expect((await listFederationsForCoop(coop.id)).map((f) => f.id)).toContain(fed.id);
    await removeMember(fed.id, coop.id);
    expect((await listFederationsForCoop(coop.id)).map((f) => f.id)).not.toContain(fed.id);
  });

  it("is idempotent on addMember", async () => {
    const fed = await createFederation("Fed", `FED${Date.now()}`, "NGN");
    const coop = await makeCoop(`C${Date.now()}`);
    await addMember(fed.id, coop.id);
    await addMember(fed.id, coop.id);
    expect(await prisma.federationMembership.count({ where: { federationId: fed.id } })).toBe(1);
  });
});
