import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupDatabase, prisma } from "../tests/setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { clearMemberCache } from "../src/services/cooperative.js";

// tests/setup.ts wraps src/lib/messaging.js in vi.fn() over the real implementation and
// mocks the transport underneath, so `sendText` here records calls AND runs real logic.

const PHONE = "2348099990001";

function replies(): string[] {
  return vi.mocked(sendText).mock.calls.map((c) => c[0].text);
}

async function makeUnconsentedMember(role: "member" | "superadmin" = "member") {
  const coop = await prisma.cooperative.create({ data: { name: "Consent Coop", code: "CNS01" } });
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  // Mirrors how registerCooperative (superadmin) and bulk import create members: no consentAt.
  return prisma.member.create({
    data: { code, phone: PHONE, name: "Ghost Member", cooperativeId: coop.id, role, pin: hashPin("1234"), wallet: { create: {} } },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemberCache();
  await prisma.dataConsent.deleteMany();
  await cleanupDatabase();
});

describe("consent gate: members created without consentAt", () => {
  it("gets the message-consent prompt instead of silence, and the session awaits the answer", async () => {
    await makeUnconsentedMember("superadmin");

    await handleMessage(PHONE, "menu");

    const out = replies().join("\n");
    expect(out).toContain("Message Consent");
    expect(out).toContain("Reply *YES*");
    const session = await prisma.session.findUnique({ where: { phone: PHONE } });
    expect(session?.state).toBe("awaiting_optin");
  });

  it("YES records consent and the next command works", async () => {
    const m = await makeUnconsentedMember();
    await handleMessage(PHONE, "balance");
    await handleMessage(PHONE, "yes");

    const after = await prisma.member.findUnique({ where: { id: m.id } });
    expect(after?.consentAt).not.toBeNull();
    expect(after?.optedOut).toBe(false);

    vi.mocked(sendText).mockClear();
    await handleMessage(PHONE, "balance");
    expect(replies().join("\n")).toContain("your savings balance is");
  });

  it("NO opts out of notifications but does NOT block commands, and is not re-asked", async () => {
    const m = await makeUnconsentedMember();
    await handleMessage(PHONE, "balance");
    await handleMessage(PHONE, "no");

    const after = await prisma.member.findUnique({ where: { id: m.id } });
    expect(after?.optedOut).toBe(true);
    expect(after?.consentAt).toBeNull();

    vi.mocked(sendText).mockClear();
    await handleMessage(PHONE, "balance");
    const out = replies().join("\n");
    expect(out).toContain("your savings balance is");
    expect(out).not.toContain("Message Consent");
  });

  it("an answer that is neither YES nor NO is re-asked, not treated as NO", async () => {
    const m = await makeUnconsentedMember("superadmin");
    await handleMessage(PHONE, "menu");
    vi.mocked(sendText).mockClear();

    await handleMessage(PHONE, "what is my balance");

    const after = await prisma.member.findUnique({ where: { id: m.id } });
    expect(after?.optedOut).toBe(false);
    expect(after?.consentAt).toBeNull();
    expect(replies().join("\n")).toMatch(/reply \*YES\* .*or \*NO\*/i);
    const session = await prisma.session.findUnique({ where: { phone: PHONE } });
    expect(session?.state).toBe("awaiting_optin");
  });
});

describe("opt-out semantics", () => {
  it("a member who answered NO keeps working commands (no re-prompt, no lockout)", async () => {
    const m = await makeUnconsentedMember();
    await prisma.member.update({ where: { id: m.id }, data: { optedOut: true } });
    clearMemberCache();

    vi.mocked(sendText).mockClear();
    await handleMessage(PHONE, "balance");
    expect(replies().join("\n")).toContain("your savings balance is");
  });
});
