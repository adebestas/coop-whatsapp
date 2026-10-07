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

/** A bank the member can pick from when entering an account number. */
export interface Bank {
  code: string;
  name: string;
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
  memberEmail?: string;
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
  /** List the provider's supported banks (for the guided account-entry flow). */
  listBanks?(): Promise<Bank[]>;
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
import { BANK_CODES } from "../../lib/banks.js";

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

// ===== Bank list (guided account entry) =====

/** Pretty display names for the banks in the static BANK_CODES fallback. */
const BANK_DISPLAY_NAMES: Record<string, string> = {
  "044": "Access Bank",
  "058": "GTBank",
  "057": "Zenith Bank",
  "033": "UBA",
  "011": "First Bank",
  "032": "Union Bank",
  "070": "Fidelity Bank",
  "214": "FCMB",
  "221": "Stanbic IBTC",
  "050": "Ecobank",
  "232": "Sterling Bank",
  "035": "Wema Bank",
  "076": "Polaris Bank",
  "082": "Keystone Bank",
  "215": "Unity Bank",
  "301": "Jaiz Bank",
  "101": "Providus Bank",
  "50211": "Kuda",
  "50212": "OPay",
  "999992": "PalmPay",
  "50515": "Moniepoint",
  "51318": "FairMoney",
  "030": "Globus Bank",
  "302": "Taj Bank",
  "090": "XPension",
  "100": "Paycom",
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The static fallback bank list, built from the `BANK_CODES` name→code map,
 * de-duplicated by code and given a human-readable name where we have one.
 * Used whenever the provider's bank list cannot be fetched.
 */
export function staticBanks(): Bank[] {
  const seen = new Set<string>();
  const banks: Bank[] = [];
  for (const [key, code] of Object.entries(BANK_CODES)) {
    if (seen.has(code)) continue;
    seen.add(code);
    banks.push({ code, name: BANK_DISPLAY_NAMES[code] ?? titleCase(key) });
  }
  return banks;
}

const BANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let bankCache: { at: number; banks: Bank[] } | null = null;

/** Drop the in-process bank-list cache (used by tests and diagnostics). */
export function clearBankCache(): void {
  bankCache = null;
}

/**
 * The bank list for the guided account-entry flow: the provider's live list
 * (cached for 24h), falling back to the static `BANK_CODES` map when the
 * provider call fails or returns nothing. The cache is only populated on a
 * successful provider response so a transient outage is not sticky.
 */
export async function listBanks(provider?: ProviderAdapter): Promise<Bank[]> {
  if (bankCache && Date.now() - bankCache.at < BANK_CACHE_TTL_MS) return bankCache.banks;
  try {
    const p = provider ?? (await resolveProvider());
    const banks = await p.listBanks?.();
    if (banks && banks.length) {
      bankCache = { at: Date.now(), banks };
      return banks;
    }
  } catch {
    /* fall through to the static list */
  }
  return staticBanks();
}
