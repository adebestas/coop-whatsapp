/**
 * Finding 2: the JSON backup was a credential store. Members carried PIN
 * hashes, TOTP secrets, NIN and bank details, and Session rows carried live bot
 * state. A leaked dump was therefore directly exploitable, independent of
 * bucket encryption.
 */
import { describe, expect, it } from "vitest";
import { REDACTED, REDACTED_FIELDS, redactTable } from "../src/services/backup.js";

describe("backup redaction", () => {
  it("removes every credential and identifier from member rows", () => {
    const member = {
      id: "m1",
      name: "Ada",
      phone: "2348000000000",
      pin: "salt:scrypt",
      totpSecret: "JBSWY3DPEHPK3PXP",
      nin: "12345678901",
      bvn: "22222222222",
      bankAccountNumber: "0123456789",
      bankAccountName: "ADA O",
      virtualAccountNumber: "9999999999",
    };

    const [row] = redactTable("members", [member]) as Array<Record<string, unknown>>;
    for (const field of REDACTED_FIELDS.members) {
      expect(row[field], field).toBe(REDACTED);
    }
    expect(row.name).toBe("Ada");
    expect(row.phone).toBe("2348000000000");
    // The caller's row must not be mutated in place.
    expect(member.pin).toBe("salt:scrypt");
  });

  it("keeps nulls null so the restore shape matches the columns", () => {
    const [row] = redactTable("members", [{ id: "m2", pin: null, nin: null }]) as Array<
      Record<string, unknown>
    >;
    expect(row.pin).toBeNull();
    expect(row.nin).toBeNull();
  });

  it("redacts session state", () => {
    const [row] = redactTable("sessions", [
      { id: "s1", phone: "234", data: '{"otp":"1234"}' },
    ]) as Array<Record<string, unknown>>;
    expect(row.data).toBe(REDACTED);
    expect(row.phone).toBe("234");
  });

  it("leaves tables without sensitive columns untouched", () => {
    const rows = [{ id: "l1", amount: 100 }];
    expect(redactTable("ledgerEntries", rows)).toBe(rows);
  });
});
