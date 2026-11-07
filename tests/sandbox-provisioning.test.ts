import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./setup.js";
import { listActiveCooperativeIds } from "../src/lib/tenant-context.js";
import { runInSandbox } from "../src/lib/sandbox.js";
import { resolveProvider } from "../src/services/payments/index.js";
import {
  ensureSandbox,
  getSandboxOverview,
  resetSandbox,
  SANDBOX_CODE,
} from "../src/services/sandbox.js";
import { platformOverview } from "../src/services/platform-monitoring.js";

const actor = { id: "sandbox-test-operator", phone: "2349000000099", role: "owner" };

describe("developer sandbox provisioning", () => {
  let cooperativeId = "";

  beforeAll(async () => {
    ({ cooperativeId } = await ensureSandbox());
  });

  it("provisions synthetic personas without overwriting their state on reads", async () => {
    const overview = await getSandboxOverview();
    expect(overview.cooperative.code).toBe(SANDBOX_CODE);
    expect(overview.personas).toHaveLength(7);
    expect(overview.personas.find((persona) => persona.id === "new_joiner")?.walletKobo).toBeNull();
    expect(overview.personas.find((persona) => persona.id === "active_saver")?.walletKobo).toBe(
      5_000_000,
    );

    const saver = await prisma.member.findUniqueOrThrow({
      where: { cooperativeId_phone: { cooperativeId, phone: "2349000000002" } },
      select: { wallet: { select: { id: true } } },
    });
    await prisma.wallet.update({
      where: { id: saver.wallet!.id },
      data: { balance: 4_750_000 },
    });

    await ensureSandbox();
    const afterEnsure = await prisma.wallet.findUniqueOrThrow({
      where: { id: saver.wallet!.id },
      select: { balance: true },
    });
    expect(afterEnsure.balance).toBe(4_750_000);
  });

  it("excludes sandbox cooperatives from platform totals and scheduler targets", async () => {
    const coop = await prisma.cooperative.findUniqueOrThrow({
      where: { id: cooperativeId },
      select: { isSandbox: true },
    });
    expect(coop.isSandbox).toBe(true);
    expect(await listActiveCooperativeIds()).not.toContain(cooperativeId);

    const overview = await platformOverview();
    expect(overview.coops.find((row) => row.id === cooperativeId)?.isSandbox).toBe(true);
    expect(overview.totals.coopCount).toBeLessThan(overview.coops.length);
  });

  it("routes payment provider resolution to an in-process sandbox adapter", async () => {
    const provider = await runInSandbox(cooperativeId, () => resolveProvider());
    expect(provider.result.name).toBe("sandbox");
  });

  it("resets synthetic data and restores the fixture balances", async () => {
    const result = await resetSandbox(actor);
    expect(result.deleted.Member).toBeGreaterThan(0);
    const overview = await getSandboxOverview();
    expect(overview.personas.find((persona) => persona.id === "active_saver")?.walletKobo).toBe(
      5_000_000,
    );
    const loan = await prisma.loan.findFirst({
      where: { cooperativeId, status: "disbursed" },
      select: { dueDate: true },
    });
    expect(loan?.dueDate?.getTime()).toBeLessThan(Date.now());
  });
});
