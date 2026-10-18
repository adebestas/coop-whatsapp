import { describe, it, expect } from "vitest";
import { prisma } from "./setup.js";
import { setCoopStatus, revokeCoopSessions } from "../src/services/platform-coops.js";
import { provisionCooperative } from "../src/services/cooperative-provisioning.js";

describe("coop controls", () => {
  it("suspends and reactivates a coop", async () => {
    const { cooperativeId } = await provisionCooperative({ name: "C", code: `C${Date.now()}`, adminPhone: "2348444444444" });
    await setCoopStatus(cooperativeId, "suspended");
    expect((await prisma.cooperative.findUnique({ where: { id: cooperativeId } }))?.status).toBe("suspended");
    await setCoopStatus(cooperativeId, "active");
    expect((await prisma.cooperative.findUnique({ where: { id: cooperativeId } }))?.status).toBe("active");
  });
  it("sets tokensValidAfter to revoke coop admin sessions", async () => {
    const { cooperativeId } = await provisionCooperative({ name: "D", code: `D${Date.now()}`, adminPhone: "2348555555555" });
    await revokeCoopSessions(cooperativeId);
    expect((await prisma.cooperative.findUnique({ where: { id: cooperativeId } }))?.tokensValidAfter).toBeInstanceOf(Date);
  });
});
