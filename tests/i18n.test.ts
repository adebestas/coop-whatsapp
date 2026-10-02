import { describe, expect, it } from "vitest";
import { detectLocale, languageInstruction, t, type Locale } from "../src/lib/i18n.js";

describe("language detection", () => {
  it("detects pidgin", () => {
    expect(detectLocale("wetin dey happen with my money abeg")).toBe("pidgin");
  });
  it("detects hausa", () => {
    expect(detectLocale("ina kwana, yaya kudi na?")).toBe("hausa");
  });
  it("detects yoruba", () => {
    expect(detectLocale("bawo ni owo mi?")).toBe("yoruba");
  });
  it("detects igbo", () => {
    expect(detectLocale("kedu ka ego m dị?")).toBe("igbo");
  });
  it("defaults to english", () => {
    expect(detectLocale("what is my balance?")).toBe("en");
  });
});

describe("translations", () => {
  it("returns localized strings with english fallback", () => {
    expect(t("pidgin", "member.balance")).toContain("money");
    expect(t("hausa", "member.balance")).toBe("💰 Kudin ka");
    expect(t("en", "member.balance")).toBe("💰 Your Balance");
    // Unknown key passes through untouched (never throws).
    expect(t("pidgin", "nonexistent.key")).toBe("nonexistent.key");
  });
});

describe("language instruction", () => {
  it("maps locales to prompt suffix", () => {
    const locales: Locale[] = ["en", "pidgin", "hausa", "yoruba", "igbo"];
    for (const locale of locales) {
      expect(languageInstruction(locale)).toMatch(/Reply in/i);
    }
  });
});