import { describe, it, expect } from "vitest";
import { calculateMonthlyPayment, calculateInterestPortion } from "../src/services/loans.js";

/**
 * Declining-balance amortization: `balance` is the OUTSTANDING PRINCIPAL, and
 * each installment = interest on the remaining principal + principal repayment.
 * The loan must reach zero after exactly `tenureMonths` installments.
 */
describe("loan amortization (declining balance)", () => {
  const principal = 10_000_000; // ₦100,000 in kobo
  const tenure = 3;

  it("closes the loan after the contractual installments when balance = principal", () => {
    const monthly = calculateMonthlyPayment(principal, tenure);
    let balance = principal;
    for (let i = 0; i < tenure; i++) {
      const interest = calculateInterestPortion(balance, tenure);
      const principalPortion = Math.min(Math.max(0, monthly - interest), balance);
      balance -= principalPortion;
    }
    expect(balance).toBeLessThanOrEqual(0);
  });

  it("does NOT close if balance starts at total repayable (the old bug)", () => {
    const monthly = calculateMonthlyPayment(principal, tenure);
    let balance = monthly * tenure; // old: principal + all interest
    for (let i = 0; i < tenure; i++) {
      const interest = calculateInterestPortion(balance, tenure);
      const principalPortion = Math.max(0, monthly - interest);
      balance -= principalPortion;
    }
    expect(balance).toBeGreaterThan(0);
  });
});
