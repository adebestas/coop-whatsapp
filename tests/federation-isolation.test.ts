// tests/federation-isolation.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  createFederation,
  addMember,
  listFederationsForCoop,
} from "../src/services/federation/index.js";

describe("federation isolation", () => {
  it("a coop only sees federations it belongs to", async () => {
    const fedA = await createFederation("Fed A", `FA${Date.now()}`, "NGN");
    const fedB = await createFederation("Fed B", `FB${Date.now()}`, "NGN");
    const coop = await prisma.cooperative.create({
      data: { name: "Coop", code: `C${Date.now()}`, currency: "NGN" },
    });
    await addMember(fedA.id, coop.id);
    const feds = await listFederationsForCoop(coop.id);
    expect(feds.map((f) => f.id)).toContain(fedA.id);
    expect(feds.map((f) => f.id)).not.toContain(fedB.id);
  });
});
