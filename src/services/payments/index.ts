/**
 * Payment provider abstraction. Both Monnify and Paystack implement this
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
  /** Provider name, e.g. paystack */
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

/** A provider webhook notification about a payout/transfer WE initiated. */
export interface PayoutNotification {
  /** Our internal reference (Payout.idempotencyKey / provider reference). */
  reference: string;
  status: "successful" | "failed";
  providerRef?: string;
  provider: string;
  raw: unknown;
}

export interface PayoutResult {
  ok: boolean;
  providerRef?: string;
  error?: string;
  /**
   * True when the provider ACCEPTED the transfer but it is not yet confirmed
   * (e.g. Monnify awaiting a per-transfer OTP). Callers must treat this as an
   * ambiguous "unsure" outcome — never as a confirmed failure — so they do not
   * refund/reverse money that may already be in flight.
   */
  pending?: boolean;
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

// ===== Direct-debit mandates =====

export interface CreateMandateParams {
  memberName: string;
  memberEmail: string;
  memberPhone: string;
  accountNumber: string;
  bankCode: string;
  accountName: string;
  amountCap: number; // kobo
  reference: string;
  narration?: string;
  redirectUrl?: string;
}

export interface MandateResult {
  ok: boolean;
  providerMandateId?: string;
  authorizationUrl?: string;
  status?: string;
  error?: string;
}

export interface DebitMandateParams {
  providerMandateId: string;
  amount: number; // kobo
  reference: string;
  narration?: string;
}

export interface DebitResult {
  ok: boolean;
  providerRef?: string;
  status?: string;
  error?: string;
}

export interface CancelMandateParams {
  providerMandateId: string;
}

export interface MandateNotification {
  providerMandateId: string;
  status: "active" | "cancelled" | "failed" | "expired";
  provider: string;
  raw: unknown;
}

export interface DebitNotification {
  reference: string;
  status: "successful" | "failed";
  providerTransactionId?: string;
  reason?: string;
  provider: string;
  raw: unknown;
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
  /**
   * Parse a raw webhook body into a PayoutNotification (a transfer we
   * initiated settling/failing), or null if the event is not a payout update.
   */
  parsePayoutNotification?(body: unknown): PayoutNotification | null;
  /**
   * Ask the provider about a transfer we initiated (payout status polling).
   * Lets us settle or refund rows stuck in "processing" without waiting for
   * a webhook that may never arrive.
   */
  getTransferStatus?(reference: string): Promise<TransferStatus>;
  /** Create a direct-debit mandate authorization; returns the consent link. */
  createMandate?(params: CreateMandateParams): Promise<MandateResult>;
  /** Pull a variable amount (≤ mandate cap) under an active mandate. */
  debitMandate?(params: DebitMandateParams): Promise<DebitResult>;
  /** Cancel an existing mandate at the provider. */
  cancelMandate?(params: CancelMandateParams): Promise<{ ok: boolean; error?: string }>;
  /** Parse a mandate status webhook into a MandateNotification, or null if irrelevant. */
  parseMandateNotification?(body: unknown): MandateNotification | null;
  /** Parse a debit result webhook into a DebitNotification, or null if irrelevant. */
  parseDebitNotification?(body: unknown): DebitNotification | null;
}

export interface TransferStatus {
  status: "successful" | "failed" | "pending" | "unknown";
  providerRef?: string;
  error?: string;
}

import { timingSafeEqual } from "node:crypto";
import { monnifyAdapter } from "./monnify.js";
import { paystackAdapter } from "./paystack.js";
import { RedisCircuitBreaker } from "../../lib/redis-mutex.js";

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
 * Uses Redis-backed circuit breaker for multi-instance safety.
 */
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;

export async function markProviderDown(name: string): Promise<void> {
  await RedisCircuitBreaker.markDown(name, PROVIDER_COOLDOWN_MS);
}

/** Mark a provider as available again after a successful operation. */
export async function markProviderUp(name: string): Promise<void> {
  await RedisCircuitBreaker.markUp(name);
}

export async function isProviderAvailable(name: string): Promise<boolean> {
  return RedisCircuitBreaker.isAvailable(name);
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
export async function resolveProvider(preferred?: string): Promise<ProviderAdapter> {
  const configured = (preferred ?? process.env.PAYMENT_PROVIDER ?? "monnify").toLowerCase();
  const order = [configured, ...ALL_PROVIDERS.filter((p) => p !== configured)];
  for (const name of order) {
    const adapter = adapterFor(name);
    if (adapter && (await isProviderAvailable(name))) return adapter;
  }
  // Everything is marked down — fall back to the configured one and let the
  // caller surface the error.
  return adapterFor(configured) ?? monnifyAdapter;
}
