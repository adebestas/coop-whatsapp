import { describe, it, expect } from "vitest";
import {
  calculateMonthlyPayment,
  calculateInterestPortion,
  calculatePrincipalPortion,
  totalRepayable,
} from "../src/services/loans.js";

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

  it("returns integer kobo and closes across all tenure tiers and odd principals", () => {
    const principals = [50_000, 333_333, 1_000_001, 10_000_000];
    const tenures = [1, 3, 4, 6, 7, 9, 10, 11, 12];

    for (const p of principals) {
      for (const t of tenures) {
        const monthly = calculateMonthlyPayment(p, t);
        const total = totalRepayable(p, t);
        expect(Number.isInteger(monthly)).toBe(true);
        expect(Number.isInteger(total)).toBe(true);
        expect(monthly).toBeGreaterThan(0);
        expect(total).toBe(monthly * t);

        let balance = p;
        for (let i = 0; i < t; i++) {
          const interest = calculateInterestPortion(balance, t);
          const principalPortion = calculatePrincipalPortion(monthly, balance, t);
          expect(Number.isInteger(interest)).toBe(true);
          expect(Number.isInteger(principalPortion)).toBe(true);
          balance -= Math.min(principalPortion, balance);
        }
        expect(balance).toBeLessThanOrEqual(0);
      }
    }
  });
});
