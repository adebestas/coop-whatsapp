import { createHash, timingSafeEqual } from "node:crypto";
import type {
  ProviderAdapter,
  CreateVirtualAccountParams,
  VirtualAccountData,
  PaymentNotification,
  ResolveAccountParams,
  ResolveAccountResult,
  PayoutParams,
  PayoutResult,
  TransferStatus,
} from "./index.js";
import { signaturesMatch } from "./index.js";
import { forProvider } from "../../lib/money.js";

/**
 * Monnify adapter — primary payment provider.
 *
 * Docs: https://developers.monnify.com
 * Env: MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE,
 *      MONNIFY_BASE_URL (default: sandbox), MONNIFY_TRANSFER_OTP (sandbox OTP).
 */

const BASE_URL = process.env.MONNIFY_BASE_URL || (
  process.env.NODE_ENV === "production"
    ? (() => { throw new Error("MONNIFY_BASE_URL is required in production — refusing to start with sandbox URL"); })()
    : "https://sandbox.monnify.com"
);

let cachedToken: { token: string; expiresAt: number } | null = null;

function configured(): boolean {
  return Boolean(process.env.MONNIFY_API_KEY && process.env.MONNIFY_SECRET_KEY && process.env.MONNIFY_CONTRACT_CODE);
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }
  const basic = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString("base64");
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}` },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Monnify auth failed (${res.status})`);
  const json = (await res.json()) as { responseBody: { accessToken: string; expiresIn: number } };
  cachedToken = { token: json.responseBody.accessToken, expiresAt: Date.now() + json.responseBody.expiresIn * 1000 };
  return cachedToken.token;
}

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const json = (await res.json()) as T;
  return json;
}

interface MonnifyResponse<T> {
  requestSuccessful: boolean;
  responseMessage?: string;
  responseCode?: string;
  responseBody: T;
}

export const monnifyAdapter: ProviderAdapter = {
  name: "monnify",

  verifyWebhook(rawBody, headers): boolean {
    // Monnify signs webhooks with a SHA512 digest of (raw body + secret).
    const secret = process.env.MONNIFY_SECRET_KEY ?? "";
    const signature = String(headers["monnify-signature"] ?? "");
    if (!signature || !secret || typeof rawBody !== "string") return false;
    const expected = createHash("sha512").update(rawBody + secret).digest("hex");
    return signaturesMatch(expected, signature);
  },

  parseNotification(body: unknown): PaymentNotification | null {
    const b = body as any;
    const eventType: string | undefined = b?.eventType ?? b?.type;
    if (!eventType?.toUpperCase().includes("SUCCESSFUL_TRANSACTION")) return null;
    const payload = b?.eventData ?? {};
    const account = payload.destinationAccountInformation?.accountNumber ?? payload.accountNumber;
    if (!account) return null;
    return {
      transactionId: String(payload.transactionReference ?? payload.transactionId ?? ""),
      reference: payload.product?.reference ?? payload.paymentReference,
      accountNumber: String(account),
      // Monnify reports amounts in NAIRA; the wallet stores kobo — convert here so
      // every PaymentNotification.amount is uniformly in kobo (mirrors Paystack).
      amount: Math.round(Number(payload.amountPaid ?? payload.amount ?? 0) * 100),
      currency: String(payload.currencyCode ?? "NGN"),
      status: "successful",
      provider: "monnify",
      raw: body,
    };
  },

  async getTransferStatus(reference) {
    if (!configured()) return { status: "unknown", error: "Monnify is not configured" };
    try {
      const res = await api<MonnifyResponse<{
        reference?: string;
        status?: string;
        providerReference?: string;
      }>>("GET", `/api/v2/disbursements/single/summary?reference=${encodeURIComponent(reference)}`);
      const s = String(res.responseBody?.status ?? "").toUpperCase();
      const status: TransferStatus["status"] =
        s === "SUCCESSFUL" || s === "PAID"
          ? "successful"
          : s === "FAILED" || s === "REVERSED"
            ? "failed"
            : s === "PENDING" || s === "ONGOING" || s === "PROCESSING"
              ? "pending"
              : "unknown";
      return { status, providerRef: res.responseBody?.providerReference };
    } catch (err: any) {
      return { status: "unknown", error: String(err?.message ?? err) };
    }
  },

  async createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountData> {
    if (!configured()) throw new Error("Monnify is not configured (MONNIFY_* env vars missing)");
    const res = await api<MonnifyResponse<{
      accountNumber: string;
      bankName: string;
      accountReference: string;
      reservationReference?: string;
    }>>("POST", "/api/v2/bank-transfer/reserved-accounts", {
      contractCode: process.env.MONNIFY_CONTRACT_CODE,
      accountReference: params.reference,
      accountName: params.name,
      customerEmail: `${params.phone}@coop.placeholder`,
      customerName: params.name,
      currencyCode: params.currency ?? "NGN",
      getAllAvailableBanks: false,
    });
    if (!res.requestSuccessful) throw new Error(res.responseMessage ?? "Monnify reserved-account failed");
    return {
      accountNumber: res.responseBody.accountNumber,
      bank: res.responseBody.bankName,
      provider: "monnify",
      providerRef: res.responseBody.reservationReference ?? res.responseBody.accountReference,
    };
  },

  async resolveAccount({ accountNumber, bankCode }: ResolveAccountParams): Promise<ResolveAccountResult> {
    if (!configured()) return { ok: false, error: "Monnify is not configured" };
    try {
      const res = await api<MonnifyResponse<{ accountName: string }>>(
        "GET",
        `/api/v1/disbursements/account-details?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`,
      );
      if (!res.requestSuccessful || !res.responseBody?.accountName) {
        return { ok: false, error: res.responseMessage ?? "account not found" };
      }
      return { ok: true, name: res.responseBody.accountName };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "resolution failed" };
    }
  },

  async payout(params: PayoutParams): Promise<PayoutResult> {
    if (!configured()) return { ok: false, error: "Monnify is not configured" };
    try {
      // Step 1: initiate the transfer (2FA required).
      const init = await api<MonnifyResponse<{
        reference: string;
        transferReference: string;
        status: string;
      }>>("POST", "/api/v2/disbursements/single", {
        amount: forProvider(params.amount, "monnify"),
        bankCode: params.bankCode,
        bankAccountNumber: params.bankAccountNumber,
        narration: `Transfer to ${params.recipientName} (${params.reference.slice(-8)})`,
        destinationAccountName: params.recipientName,
        currency: params.currency ?? "NGN",
        reference: params.reference,
        coin: "NGN",
      });
      if (!init.requestSuccessful) {
        return { ok: false, error: init.responseMessage ?? "transfer rejected" };
      }

      // Step 2: Complete transfer with OTP
      // ⚠️ PRODUCTION LIMITATION: Monnify generates a NEW OTP per transfer,
      // sent to the account holder via SMS/email from Monnify directly.
      // This env-var approach only works in sandbox. For production, use one of:
      //   1. Monnify's "business factor" API for programmatic OTP retrieval
      //   2. Route OTP to admin via WhatsApp for manual entry
      //   3. Use Monnify's "resend OTP" endpoint to trigger re-delivery
      //   4. Contact Monnify support to enable "auto-approve" for your contract
      const otp = process.env.MONNIFY_TRANSFER_OTP;
      if (!otp) {
        console.warn("[Monnify] MONNIFY_TRANSFER_OTP not set — transfers will fail in production");
        return {
          ok: false,
          error: "Monnify OTP not configured. Set MONNIFY_TRANSFER_OTP environment variable.",
        };
      }

      const validate = await api<MonnifyResponse<{ status: string }>>(
        "POST",
        "/api/v2/disbursements/single/complete",
        { reference: init.responseBody.transferReference, authorizationCode: otp },
      );
      if (!validate.requestSuccessful || validate.responseBody.status === "FAILED") {
        return { ok: false, error: validate.responseMessage ?? "transfer validation failed" };
      }
      return { ok: true, providerRef: init.responseBody.reference };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "monnify payout failed" };
    }
  },
};
