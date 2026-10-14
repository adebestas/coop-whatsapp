// tests/country-currency.test.ts
import { describe, it, expect } from "vitest";
import {
  currencyForCountry,
  countryForCurrency,
  countryFromPhone,
} from "../src/lib/currency.js";
import { createCooperative } from "../src/services/cooperative.js";

describe("country → currency", () => {
  it("maps countries to currencies", () => {
    expect(currencyForCountry("GH")).toBe("GHS");
    expect(currencyForCountry("gh")).toBe("GHS");
    expect(currencyForCountry("XX")).toBe("NGN");
  });

  it("maps currencies back to countries", () => {
    expect(countryForCurrency("KES")).toBe("KE");
    expect(countryForCurrency("XXX")).toBe("NG");
  });

  it("infers country from an E.164 phone (longest prefix wins)", () => {
    expect(countryFromPhone("+2348012345678")).toBe("NG");
    expect(countryFromPhone("+233201234567")).toBe("GH");
    expect(countryFromPhone("+254712345678")).toBe("KE");
    expect(countryFromPhone("+27821234567")).toBe("ZA");
    expect(countryFromPhone("08012345678")).toBeNull();
  });

  it("createCooperative infers country + currency from adminPhone", async () => {
    const coop = await createCooperative({
      name: "Accra Coop",
      code: `AC${Date.now()}`,
      adminPhone: "+233201234567",
    });
    expect(coop.country).toBe("GH");
    expect(coop.currency).toBe("GHS");
  });
});