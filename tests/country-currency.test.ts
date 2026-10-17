// tests/country-currency.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  currencyForCountry,
  countryForCurrency,
  countryFromPhone,
} from "../src/lib/currency.js";
import { createCooperative, clearMemberCache } from "../src/services/cooperative.js";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { handleAdminCommand } from "../src/services/admin.js";
import { postJournal } from "../src/services/journal.js";

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

describe("setconfig country guard", () => {
  beforeEach(async () => {
    clearMemberCache();
    await cleanupDatabase();
  });

  it("allows the country/currency change when no journal entry exists", async () => {
    const coop = await createTestCoop("CCY1");
    const admin = await createTestMember(coop.id, { phone: "2348000050001", role: "superadmin" });

    await handleAdminCommand(admin.phone, "setconfig", ["country", "GH"]);

    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.country).toBe("GH");
    expect(after?.currency).toBe("GHS");
  });

  it("blocks the country/currency change once any journal entry exists", async () => {
    const coop = await createTestCoop("CCY2");
    const admin = await createTestMember(coop.id, { phone: "2348000050011", role: "superadmin" });

    const posted = await postJournal({
      cooperativeId: coop.id,
      description: "Historical contribution",
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: 100000 },
        { account: "income:contribution", direction: "CREDIT", amount: 100000 },
      ],
    });
    expect(posted.posted).toBe(true);

    await handleAdminCommand(admin.phone, "setconfig", ["country", "GH"]);

    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.country).toBe("NG");
    expect(after?.currency).toBe("NGN");
  });
});