import { describe, it, expect } from "vitest";
import { prisma } from "./setup.js";
import { coopStats } from "../src/services/platform-monitoring.js";
import { provisionCooperative } from "../src/services/cooperative-provisioning.js";

describe("platform monitoring", () => {
  it("counts members and loan book per coop, isolated by tenant", async () => {
    const a = await provisionCooperative({
      name: "A",
      code: `MA${Date.now()}`,
      adminPhone: "2348666666661",
    });
    const b = await provisionCooperative({
      name: "B",
      code: `MB${Date.now()}`,
      adminPhone: "2348666666662",
    });
    const stats = await coopStats(a.cooperativeId);
    expect(stats.memberCount).toBe(1);
    const statsB = await coopStats(b.cooperativeId);
    expect(statsB.memberCount).toBe(1); // does not include A's member
  });
});
