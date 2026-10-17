import { describe, it, expect } from "vitest";
import { resolveMemberLocale } from "../src/services/conversation.js";

describe("resolveMemberLocale", () => {
  it("prefers the member's stored preference", () => {
    expect(resolveMemberLocale({ locale: "yoruba" }, "hausa", "hello")).toBe("yoruba");
  });
  it("falls back to the coop default", () => {
    expect(resolveMemberLocale({ locale: null }, "hausa", "hello")).toBe("hausa");
  });
  it("falls back to auto-detect when neither is set", () => {
    expect(resolveMemberLocale({ locale: null }, "en", "bawo ni")).toBe("yoruba");
  });
  it("defaults to English when nothing matches", () => {
    expect(resolveMemberLocale({ locale: null }, "en", "hello")).toBe("en");
  });
});
