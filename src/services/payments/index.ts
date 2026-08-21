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

export interface ResolveAccountParams {
  /** Recipient bank account number */
  accountNumber: string;
  /** Recipient bank code (provider-specific) */
  bankCode: string;
}

export interface ResolveAccountResult {
  ok: boolean;
  /** The name registered on the account (for verification) */
  name?: string;
  error?: string;
}

export interface ProviderAdapter {
  name: string;
  createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountData>;
  /** Send a payout/transfer to a bank account */
  payout?(params: PayoutParams): Promise<PayoutResult>;
  /** Resolve an account and return the registered account name */
  resolveAccount?(params: ResolveAccountParams): Promise<ResolveAccountResult>;
  /**
   * Validate an incoming webhook request. `rawBody` is the EXACT bytes the
   * provider sent (captured before JSON parsing) — signatures must be
   * computed over the raw payload, never a re-serialization.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  /** Parse a raw webhook body into a PaymentNotification, or null if irrelevant */
  parseNotification(body: unknown): PaymentNotification | null;
}

import { timingSafeEqual } from "node:crypto";
import { monnifyAdapter } from "./monnify.js";
import { paystackAdapter } from "./paystack.js";

/** Constant-time string comparison for signature checks (anti-timing-attack). */
export function signaturesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(String(expected), "utf8");
  const b = Buffer.from(String(received ?? ""), "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Provider availability (circuit breaker). When a provider fails — network
 * outage, downtime — we mark it down for a cooldown and route to the other
 * provider automatically.
 */
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
const providerDownUntil = new Map<string, number>();

export function markProviderDown(name: string): void {
  providerDownUntil.set(name.toLowerCase(), Date.now() + PROVIDER_COOLDOWN_MS);
}

export function isProviderAvailable(name: string): boolean {
  const until = providerDownUntil.get(name.toLowerCase());
  return !until || until < Date.now();
}

function adapterFor(name: string): ProviderAdapter | null {
  switch (name.toLowerCase()) {
    case "paystack":
      return paystackAdapter;
    case "monnify":
      return monnifyAdapter;
    default:
      return null;
  }
}

const ALL_PROVIDERS = ["monnify", "paystack"];

/** Preferred provider first (env or explicit), then any healthy fallback. */
export function resolveProvider(preferred?: string): ProviderAdapter {
  const configured = (preferred ?? process.env.PAYMENT_PROVIDER ?? "monnify").toLowerCase();
  const order = [configured, ...ALL_PROVIDERS.filter((p) => p !== configured)];
  for (const name of order) {
    const adapter = adapterFor(name);
    if (adapter && isProviderAvailable(name)) return adapter;
  }
  // Everything is marked down — fall back to the configured one and let the
  // caller surface the error.
  return adapterFor(configured) ?? monnifyAdapter;
}