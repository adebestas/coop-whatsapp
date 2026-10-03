/**
 * Shared payment-provider behaviour for tests.
 *
 * tests/setup.ts registers the payments module mock before the app is imported,
 * so a per-file `vi.mock` of the same module is inert. Tests that need to drive
 * the provider (name mismatch, resolution failure, payout failure) must arm this
 * object instead.
 */
export const paymentState = {
  /** Name the provider reports for a bank account. */
  resolveName: "ADA OBI",
  /** When true the provider cannot resolve the account at all. */
  resolveFails: false,
  /** When true the payout attempt fails. */
  payoutFails: false,
  /** When true the provider accepted the transfer but it is not yet confirmed
   *  (e.g. Monnify awaiting OTP authorization) — must map to "unsure". */
  payoutPending: false,
};
