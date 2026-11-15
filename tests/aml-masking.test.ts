import { describe, it, expect, beforeEach } from "vitest";
import { prisma, cleanupDatabase, createTestCoop, createTestMember } from "./setup.js";
import { maskPhone, generateSTR, handleSTR } from "../src/services/aml.js";

beforeEach(async () => {
  await cleanupDatabase();
});

describe("NDPR / AML PII Masking (maskPhone & generateSTR)", () => {
  it("masks phone numbers correctly according to NDPR guidelines", () => {
    expect(maskPhone("+2348012345678")).toBe("+23480*****678");
    expect(maskPhone("2348012345678")).toBe("23480*****678");
    expect(maskPhone("08012345678")).toBe("08012*****678");
    expect(maskPhone("12345")).toBe("****345");
    expect(maskPhone("")).toBe("");
  });

  it("masks member phone numbers in generated STR summaries and report objects", async () => {
    const coop = await createTestCoop("STRMSK1");
    const member = await createTestMember(coop.id, {
      phone: "2348012345678",
      name: "Tunde Privacy",
    });

    const report = await generateSTR("2348012345678", coop.id);
    expect(report).not.toBeNull();
    expect(report!.memberName).toBe("Tunde Privacy");
    // Ensure the raw phone number does not leak in memberPhone or summary
    expect(report!.memberPhone).toBe("23480*****678");
    expect(report!.summary).toContain("Member: Tunde Privacy (23480*****678)");
    expect(report!.summary).not.toContain("(2348012345678)");
  });

  it("handleSTR uses masked phone number in output", async () => {
    const coop = await createTestCoop("STRMSK2");
    await createTestMember(coop.id, {
      phone: "2348099998888",
      name: "Amina Compliance",
    });

    const result = await handleSTR("2348099998888", coop.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("*Amina Compliance* (23480*****888)");
    expect(result.message).not.toContain("2348099998888");
  });

  it("does not echo the submitted phone number when no member matches", async () => {
    const coop = await createTestCoop("STRMSK3");
    const result = await handleSTR("2348000000000", coop.id);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("2348000000000");
  });
});
