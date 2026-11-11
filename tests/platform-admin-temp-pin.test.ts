import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "./setup.js";
import { createPlatformAdmin } from "../src/services/platform-admin.js";
import { verifyPin } from "../src/lib/security.js";

describe("platform admin temp PIN", () => {
  beforeEach(async () => {
    await prisma.platformAdmin.deleteMany();
  });

  it("issues a 6-digit temp PIN that verifies against the stored hash", async () => {
    const result = await createPlatformAdmin({
      name: "Temp Admin",
      phone: "2348097111222",
      role: "developer",
    });

    expect(result.tempPin).toMatch(/^\d{6}$/);
    const row = await prisma.platformAdmin.findUnique({ where: { id: result.id } });
    expect(row?.mustChangePin).toBe(true);
    expect(verifyPin(result.tempPin, row!.pin!)).toBe(true);
  });
});
