import { describe, expect, it } from "vitest";
import { detectLocale, languageInstruction, t, type Locale } from "../src/lib/i18n.js";
import { runWithLocale } from "../src/lib/runtime-context.js";

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
    expect(t("member.balance", undefined, "pidgin")).toContain("money");
    expect(t("member.balance", undefined, "hausa")).toBe("💰 Kudin ka");
    expect(t("member.balance", undefined, "en")).toBe("💰 Your Balance");
    // Unknown key passes through untouched (never throws).
    expect(t("nonexistent.key", undefined, "pidgin")).toBe("nonexistent.key");
  });
});

describe("t() reads the runtime locale", () => {
  it("uses the context locale", () => {
    runWithLocale("yoruba", () => {
      expect(t("money.balance")).toBe("💰 Owo re");
    });
  });
  it("falls back to English for an unknown key", () => {
    expect(t("does.not.exist")).toBe("does.not.exist");
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