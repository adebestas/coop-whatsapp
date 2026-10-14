/**
 * Money utilities for kobo-based storage.
 * All monetary values are stored as integers in kobo (₦1 = 100 kobo).
 * This prevents floating-point rounding errors.
 */

import { formatMoney } from "./currency.js";
import { getCurrency } from "./runtime-context.js";

// ===== Conversion Helpers =====

/**
 * Convert naira to kobo (e.g., 1000.50 → 100050)
 */
export function toKobo(naira: number): number {
  return Math.round(naira * 100);
}

/**
 * Convert kobo to naira (e.g., 100050 → 1000.50)
 */
export function toNaira(kobo: number): number {
  return kobo / 100;
}

/**
 * Format a balance for display in the current cooperative's currency.
 * `currency` overrides the runtime context (default NGN).
 */
export function formatBalance(kobo: number, currency?: string): string {
  return formatMoney(kobo, currency ?? getCurrency());
}

/**
 * Format amount for provider APIs (Paystack expects kobo, Monnify/Flutterwave expect naira)
 */
export function forProvider(amount: number, provider: "paystack" | "monnify" | "flutterwave"): number {
  switch (provider) {
    case "paystack":
      return amount; // Already in kobo
    case "monnify":
    case "flutterwave":
      return toNaira(amount); // Convert to naira
  }
}

// ===== Limits (in kobo) =====

export const LIMITS = {
  MIN_SAVE: toKobo(100), // ₦100
  MAX_SAVE: toKobo(10_000_000), // ₦10M
  MIN_LOAN: toKobo(1_000), // ₦1,000
  MAX_LOAN: toKobo(50_000_000), // ₦50M
  MIN_WITHDRAW: toKobo(100), // ₦100
  MAX_WITHDRAW: toKobo(20_000_000), // ₦20M
  MAX_LOAN_TENURE: 24, // months
  MIN_LOAN_TENURE: 1, // month
  MAX_PAYANYONE: toKobo(50_000_000), // ₦50M per transaction
  DAILY_PAYANYONE_LIMIT: toKobo(100_000_000), // ₦100M per day
} as const;
