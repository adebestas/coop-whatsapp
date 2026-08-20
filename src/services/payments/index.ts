/**
 * Payment provider abstraction. Both Flutterwave and Paystack implement this
 * so the rest of the app never depends on a specific vendor.
 */

export interface VirtualAccountData {
  /** Account number the member can receive transfers into */
  accountNumber: string;
  /** Bank name / provider label shown to the member */
  bank: string;
  /** Provider name that issued the account */
  provider: string;
  /** Provider-side reference for the virtual account */
  providerRef?: string;
}

export interface CreateVirtualAccountParams {
  /** E.164 phone number of the member */
  phone: string;
  /** Member display name */
  name: string;
  /** Internal reference (e.g. member id) */
  reference: string;
  /** ISO currency, e.g. NGN */
  currency?: string;
}

/** A webhook notification of a credit/transfer into a virtual account. */
export interface PaymentNotification {
  /** Provider's internal id for this transaction */
  transactionId: string;
  /** Provider reference we control (usually matches our internal reference) */
  reference?: string;
  /** The member's virtual account number that received the money */
  accountNumber: string;
  amount: number;
  currency: string;
  status: "successful" | "failed" | "pending";
  /** Provider name, e.g. flutterwave */
  provider: string;
  raw: unknown;
}

export interface PayoutParams {
  amount: number;
  /** Recipient bank account number */
  bankAccountNumber: string;
  /** Recipient bank code (provider-specific) */
  bankCode: string;
  /** Recipient display name */
  recipientName: string;
  /** Internal reference */
  reference: string;
  currency?: string;
}

export interface PayoutResult {
  ok: boolean;
  providerRef?: string;
  error?: string;
}

export interface ProviderAdapter {
  name: string;
  createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountData>;
  /** Send a payout/transfer to a bank account */
  payout?(params: PayoutParams): Promise<PayoutResult>;
  /** Validate an incoming webhook request (signature/headers) */
  verifyWebhook(body: unknown, headers: Record<string, string | string[] | undefined>): boolean;
  /** Parse a raw webhook body into a PaymentNotification, or null if irrelevant */
  parseNotification(body: unknown): PaymentNotification | null;
}

/** Adapter resolution. Controlled by PAYMENT_PROVIDER env var. */
export function resolveProvider(): ProviderAdapter {
  const name = (process.env.PAYMENT_PROVIDER ?? "flutterwave").toLowerCase();
  switch (name) {
    case "paystack":
      return paystackAdapter;
    case "flutterwave":
    default:
      return flutterwaveAdapter;
  }
}

import { flutterwaveAdapter } from "./flutterwave.js";
import { paystackAdapter } from "./paystack.js";