import { test, expect } from "vitest";
import { createHmac } from "node:crypto";
import { CubeCoverClient } from "../../src/services/insurance/cubecover.js";

const SECRET = "test-secret";

test("parseNotification parses a valid event", () => {
  const client = new CubeCoverClient({ apiKey: "test", baseUrl: "https://api.cubecover.ai" });
  const result = client.parseNotification({ event: "policy.created", data: {} });
  expect(result?.event).toBe("policy.created");
});

test("parseNotification rejects a body without an event", () => {
  const client = new CubeCoverClient({ apiKey: "test", baseUrl: "https://api.cubecover.ai" });
  expect(client.parseNotification({ data: {} })).toBeNull();
  expect(client.parseNotification(null)).toBeNull();
});

test("verifyWebhook accepts a correct signature", () => {
  const client = new CubeCoverClient({
    apiKey: "test",
    baseUrl: "https://api.cubecover.ai",
    webhookSecret: SECRET,
  });
  const body = JSON.stringify({ event: "test", data: {} });
  const sig = createHmac("sha256", SECRET).update(body).digest("hex");
  expect(client.verifyWebhook(body, sig)).toBe(true);
});

test("verifyWebhook rejects a wrong or missing signature", () => {
  const client = new CubeCoverClient({
    apiKey: "test",
    baseUrl: "https://api.cubecover.ai",
    webhookSecret: SECRET,
  });
  const body = JSON.stringify({ event: "test", data: {} });
  expect(client.verifyWebhook(body, "deadbeef")).toBe(false);
  expect(client.verifyWebhook(body, undefined)).toBe(false);
});

test("verifyWebhook fails closed when no secret is configured", () => {
  const client = new CubeCoverClient({ apiKey: "test", baseUrl: "https://api.cubecover.ai" });
  const body = JSON.stringify({ event: "test", data: {} });
  const sig = createHmac("sha256", "").update(body).digest("hex");
  expect(client.verifyWebhook(body, sig)).toBe(false);
});
