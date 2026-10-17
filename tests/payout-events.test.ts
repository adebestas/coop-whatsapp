import { describe, expect, it } from "vitest";
import { paystackAdapter } from "../src/services/payments/paystack.js";
import { monnifyAdapter } from "../src/services/payments/monnify.js";

describe("transfer-callback parsing (naming-drift tolerant)", () => {
  it("Paystack: maps transfer.success / failed / reversed", () => {
    expect(
      paystackAdapter.parsePayoutNotification!({
        event: "transfer.success",
        data: { reference: "R1", transfer_code: "TRF_1" },
      }),
    ).toMatchObject({ reference: "R1", status: "successful", provider: "paystack" });

    expect(
      paystackAdapter.parsePayoutNotification!({
        event: "transfer.failed",
        data: { reference: "R1" },
      })?.status,
    ).toBe("failed");

    expect(
      paystackAdapter.parsePayoutNotification!({
        event: "transfer.reversed",
        data: { reference: "R1" },
      })?.status,
    ).toBe("failed");
  });

  it("Paystack: ignores non-transfer events", () => {
    expect(
      paystackAdapter.parsePayoutNotification!({
        event: "charge.success",
        data: { reference: "R1" },
      }),
    ).toBeNull();
  });

  it("Monnify: maps disbursement success/failed and ignores transaction credits", () => {
    expect(
      monnifyAdapter.parsePayoutNotification!({
        eventType: "SUCCESSFUL_DISBURSEMENT",
        eventData: { reference: "R2" },
      }),
    ).toMatchObject({ reference: "R2", status: "successful", provider: "monnify" });

    expect(
      monnifyAdapter.parsePayoutNotification!({
        eventType: "FAILED_DISBURSEMENT",
        eventData: { reference: "R2" },
      })?.status,
    ).toBe("failed");

    // A credit event must not be mistaken for a payout.
    expect(
      monnifyAdapter.parsePayoutNotification!({
        eventType: "SUCCESSFUL_TRANSACTION",
        eventData: { reference: "R2" },
      }),
    ).toBeNull();
  });

  it("Monnify: falls back to paymentReference", () => {
    expect(
      monnifyAdapter.parsePayoutNotification!({
        eventType: "DISBURSEMENT_SUCCESS",
        eventData: { paymentReference: "R3" },
      })?.reference,
    ).toBe("R3");
  });
});
