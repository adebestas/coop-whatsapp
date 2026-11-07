import { afterEach, describe, expect, it, vi } from "vitest";
import { runInSandbox } from "../src/lib/sandbox.js";
import { uploadBufferToS3 } from "../src/lib/s3.js";
import { emailFiles } from "../src/services/exports.js";
import { CubeCoverClient } from "../src/services/insurance/cubecover.js";
import { ensureSandbox, runSandboxTurn } from "../src/services/sandbox.js";

describe("developer sandbox simulator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs a real conversation turn and captures the bot reply", async () => {
    const result = await runSandboxTurn({
      personaId: "active_saver",
      text: "balance",
      aiEnabled: false,
    });

    expect(result.ai.path).toBe("rules");
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.every((message) => message.to === "2349000000002")).toBe(true);
    expect(result.state.wallet?.balanceKobo).toBe(5_000_000);
  });

  it("blocks provider, email, and storage traffic inside a sandbox scope", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { cooperativeId } = await ensureSandbox();
    const client = new CubeCoverClient({
      apiKey: "test-key",
      baseUrl: "https://insurance.example.invalid",
    });

    const results = await runInSandbox(cooperativeId, async () => ({
      products: await client.getProducts(),
      emailSent: await emailFiles("test@example.invalid", "Test", "Body", []),
      uploaded: await uploadBufferToS3(Buffer.from("sandbox"), "sandbox/test"),
    }));

    expect(results.result.products).toEqual([]);
    expect(results.result.emailSent).toBe(true);
    expect(results.result.uploaded).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not create real provider side effects when a simulated payout is requested", async () => {
    const { cooperativeId } = await ensureSandbox();
    const { result } = await runInSandbox(cooperativeId, async () => {
      const { resolveProvider } = await import("../src/services/payments/index.js");
      const provider = await resolveProvider();
      return provider.payout?.({
        amount: 100_000,
        bankAccountNumber: "1234567890",
        bankCode: "044",
        recipientName: "Sandbox Member",
        reference: "sandbox-payout-test",
      });
    });

    expect(result?.ok).toBe(true);
    expect(result?.providerRef).toContain("sandbox-");
  });
});
