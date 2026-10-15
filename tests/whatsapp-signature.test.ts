import { describe, it, expect, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

/**
 * `config` reads env at module load, so each case resets the module registry,
 * sets the env, then dynamically imports the webhook route.
 */
async function loadVerify(appSecret: string | undefined, nodeEnv: string) {
  vi.resetModules();
  if (appSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
  else process.env.WHATSAPP_APP_SECRET = appSecret;
  process.env.NODE_ENV = nodeEnv;
  const mod = await import("../src/routes/webhook.js");
  return mod.verifyWhatsAppSignature;
}

const sign = (secret: string, body: string) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("WhatsApp webhook signature (App Secret)", () => {
  const origSecret = process.env.WHATSAPP_APP_SECRET;
  const origEnv = process.env.NODE_ENV;
  const origToken = process.env.WHATSAPP_TOKEN;

  afterEach(() => {
    if (origSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = origSecret;
    if (origToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = origToken;
    process.env.NODE_ENV = origEnv;
    vi.resetModules();
  });

  it("accepts a signature computed with the App Secret", async () => {
    const verify = await loadVerify("app-secret", "test");
    const body = JSON.stringify({ entry: [] });
    expect(verify(body, sign("app-secret", body))).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const verify = await loadVerify("app-secret", "test");
    const body = JSON.stringify({ entry: [] });
    expect(verify(body, sign("wrong-secret", body))).toBe(false);
  });

  it("rejects a signature computed with the access token (the old bug)", async () => {
    process.env.WHATSAPP_TOKEN = "access-token";
    const verify = await loadVerify("app-secret", "test");
    const body = JSON.stringify({ entry: [] });
    expect(verify(body, sign("access-token", body))).toBe(false);
  });

  it("rejects a missing signature", async () => {
    const verify = await loadVerify("app-secret", "test");
    expect(verify("{}", undefined)).toBe(false);
  });

  it("skips verification when the App Secret is unset in non-production", async () => {
    const verify = await loadVerify(undefined, "test");
    expect(verify("{}", undefined)).toBe(true);
  });

  it("fails closed when the App Secret is unset in production", async () => {
    const verify = await loadVerify(undefined, "production");
    const body = JSON.stringify({ entry: [] });
    expect(verify(body, sign("anything", body))).toBe(false);
  });
});
