import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { postFederationJournal } from "../src/services/federation/ledger.js";

async function makeFed() {
  return prisma.federation.create({
    data: { name: "Fed", code: `FED${Date.now()}`, baseCurrency: "NGN" },
  });
}

describe("federation ledger", () => {
  it("posts a balanced entry", async () => {
    const fed = await makeFed();
    const r = await postFederationJournal({
      federationId: fed.id,
      txRef: `FJ-${Date.now()}`,
      description: "test",
      currency: "NGN",
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: 1000 },
        { account: "coop:x:payable", direction: "CREDIT", amount: 1000 },
      ],
    });
    expect(r.posted).toBe(true);
    expect(await prisma.federationLedgerEntry.count({ where: { federationId: fed.id } })).toBe(1);
  });

  it("rejects an unbalanced entry", async () => {
    const fed = await makeFed();
    const r = await postFederationJournal({
      federationId: fed.id,
      txRef: `FJ-${Date.now()}`,
      description: "bad",
      currency: "NGN",
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: 1000 },
        { account: "coop:x:payable", direction: "CREDIT", amount: 900 },
      ],
    });
    expect(r.posted).toBe(false);
    expect(r.reason).toBe("unbalanced");
  });

  it("is idempotent on txRef", async () => {
    const fed = await makeFed();
    const ref = `FJ-${Date.now()}`;
    const opts = {
      federationId: fed.id,
      txRef: ref,
      description: "dup",
      currency: "NGN",
      postings: [
        { account: "assets:bank", direction: "DEBIT" as const, amount: 500 },
        { account: "coop:x:payable", direction: "CREDIT" as const, amount: 500 },
      ],
    };
    expect((await postFederationJournal(opts)).posted).toBe(true);
    expect((await postFederationJournal(opts)).reason).toBe("duplicate");
  });
});
