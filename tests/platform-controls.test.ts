import { describe, it, expect } from "vitest";
import { prisma } from "./setup.js";
import { setCoopStatus, revokeCoopSessions } from "../src/services/platform-coops.js";
import { provisionCooperative } from "../src/services/cooperative-provisioning.js";
import { sign, verifyAdminToken, requireLiveAdmin } from "../src/lib/admin-auth.js";
import { listActiveCooperativeIds } from "../src/lib/tenant-context.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";

async function adminToken(coopId: string) {
  const member = await prisma.member.findFirst({
    where: { cooperativeId: coopId, role: "superadmin" },
  });
  // `sign` stamps iat = now. A test that revokes must keep THIS payload: a
  // re-signed token is issued after the cutoff and is legitimately valid.
  const payload = verifyAdminToken(sign(member!.phone, coopId, "superadmin"));
  expect(payload).not.toBeNull();
  return payload!;
}

describe("coop controls", () => {
  it("suspends and reactivates a coop", async () => {
    const { cooperativeId } = await provisionCooperative({
      name: "C",
      code: `C${Date.now()}`,
      adminPhone: "2348444444444",
    });
    await setCoopStatus(cooperativeId, "suspended");
    expect((await prisma.cooperative.findUnique({ where: { id: cooperativeId } }))?.status).toBe(
      "suspended",
    );
    await setCoopStatus(cooperativeId, "active");
    expect((await prisma.cooperative.findUnique({ where: { id: cooperativeId } }))?.status).toBe(
      "active",
    );
  });

  it("sets tokensValidAfter to revoke coop admin sessions", async () => {
    const { cooperativeId } = await provisionCooperative({
      name: "D",
      code: `D${Date.now()}`,
      adminPhone: "2348555555555",
    });
    await revokeCoopSessions(cooperativeId);
    expect(
      (await prisma.cooperative.findUnique({ where: { id: cooperativeId } }))?.tokensValidAfter,
    ).toBeInstanceOf(Date);
  });

  it("rejects an admin token that was issued before sessions were revoked", async () => {
    const { cooperativeId } = await provisionCooperative({
      name: "E",
      code: `E${Date.now()}`,
      adminPhone: "2348666666666",
    });
    // Sanity: the freshly minted token is accepted.
    const before = await adminToken(cooperativeId);
    expect(await requireLiveAdmin(before)).not.toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    await revokeCoopSessions(cooperativeId);

    expect(await requireLiveAdmin(before)).toBeNull();
  });

  it("accepts a token issued AFTER the revocation cutoff", async () => {
    const { cooperativeId } = await provisionCooperative({
      name: "F",
      code: `F${Date.now()}`,
      adminPhone: "2348777777777",
    });
    await revokeCoopSessions(cooperativeId);
    await new Promise((r) => setTimeout(r, 5));
    const after = await adminToken(cooperativeId);
    expect(await requireLiveAdmin(after)).not.toBeNull();
  });

  it("suspension blocks live admin access and background processing", async () => {
    const { cooperativeId } = await provisionCooperative({
      name: "G",
      code: `G${Date.now()}`,
      adminPhone: "2348888888888",
    });
    const payload = await adminToken(cooperativeId);
    expect(await requireLiveAdmin(payload)).not.toBeNull();

    await setCoopStatus(cooperativeId, "suspended");

    expect(await requireLiveAdmin(payload)).toBeNull();
    expect(await listActiveCooperativeIds()).not.toContain(cooperativeId);
  });
});
