import { createHmac } from "node:crypto";
import { z } from "zod";
import type {
  ProviderAdapter,
  CreateVirtualAccountParams,
  VirtualAccountData,
  PaymentNotification,
  PayoutNotification,
  ResolveAccountParams,
  ResolveAccountResult,
  Bank,
  PayoutParams,
  PayoutResult,
  TransferStatus,
} from "./index.js";
import { signaturesMatch } from "./index.js";
import { forProvider } from "../../lib/money.js";
import { countryForCurrency } from "../../lib/currency.js";

const API_BASE = "https://api.flutterwave.com/v3";

/** Hard cap on any single Flutterwave HTTP call so a hung socket cannot hold a connection. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Shape contract for a charge.completed webhook payload (amounts in kobo). */
const FlutterwaveChargeSchema = z
  .object({
    event: z.string(),
    data: z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        tx_ref: z.string().optional(),
        flw_ref: z.string().optional(),
        amount: z.coerce.number(),
        charged_amount: z.coerce.number().optional(),
        app_fee: z.coerce.number().optional(),
        merchant_fee: z.coerce.number().optional(),
        processor_response: z.string().optional(),
        auth_model: z.string().optional(),
        currency: z.string().optional(),
        ip: z.string().optional(),
        narration: z.string().optional(),
        status: z.string(),
        vbv_message: z.string().optional(),
        auth_url: z.string().optional(),
        acct_validation_required: z.boolean().optional(),
        account_id: z.union([z.string(), z.number()]).optional(),
        customer: z
          .object({
            id: z.union([z.string(), z.number()]).optional(),
            name: z.string().optional(),
            phone_number: z.string().optional(),
            email: z.string().optional(),
            created_at: z.string().optional(),
          })
          .passthrough()
          .optional(),
        meta: z.record(z.unknown()).optional(),
        card: z
          .object({
            first_6digits: z.string().optional(),
            last_4digits: z.string().optional(),
            issuer: z.string().optional(),
            country: z.string().optional(),
            type: z.string().optional(),
            expiry: z.string().optional(),
          })
          .passthrough()
          .optional(),
        meta_data: z.record(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Shape contract for a transfer webhook (payout we initiated). */
const FlutterwaveTransferSchema = z
  .object({
    event: z.string(),
    data: z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        reference: z.string().optional(),
        flw_ref: z.string().optional(),
        amount: z.coerce.number().optional(),
        currency: z.string().optional(),
        status: z.string().optional(),
        complete: z.boolean().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
        fee: z.coerce.number().optional(),
        account_number: z.string().optional(),
        bank_code: z.string().optional(),
        bank_name: z.string().optional(),
        beneficiary_name: z.string().optional(),
        sender: z
          .object({
            name: z.string().optional(),
            account_number: z.string().optional(),
            bank_code: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

function getSecret(): string {
  const key = process.env.FLUTTERWAVE_SECRET_KEY ?? "";
  if (!key) {
    throw new Error("FLUTTERWAVE_SECRET_KEY is not set");
  }
  return key;
}

async function api<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getSecret()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await res.json()) as any;
  if (!res.ok || json.status !== "success") {
    throw new Error(
      `Flutterwave ${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`,
    );
  }
  return json as T;
}

/**
 * Flutterwave adapter — supports virtual accounts, payouts, account resolution,
 * bank listing, and webhook verification.
 *
 * Docs: https://developer.flutterwave.com/docs
 * Env: FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_WEBHOOK_SECRET (for webhook verification)
 */
export const flutterwaveAdapter: ProviderAdapter = {
  name: "flutterwave",

  verifyWebhook(rawBody, headers): boolean {
    const secret = process.env.FLUTTERWAVE_WEBHOOK_SECRET ?? "";
    const signature = String(headers["verif-hash"] ?? "");
    if (!signature || !secret || typeof rawBody !== "string") return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return signaturesMatch(expected, signature);
  },

  parseNotification(body: unknown): PaymentNotification | null {
    const parsed = FlutterwaveChargeSchema.safeParse(body);
    if (!parsed.success) return null;
    const b = parsed.data;
    if (b.event !== "charge.completed" || b.data?.status !== "successful") return null;
    const d = b.data;
    const accountNumber = d.meta?.account_number ?? d.meta?.accountNumber ?? "";
    return {
      transactionId: String(d.id ?? d.flw_ref ?? ""),
      reference: d.tx_ref,
      accountNumber: String(accountNumber),
      amount: Math.round(Number(d.amount ?? 0) * 100), // Flutterwave reports in naira; convert to kobo
      currency: String(d.currency ?? "NGN"),
      status: "successful",
      provider: "flutterwave",
      raw: body,
    };
  },

  parsePayoutNotification(body: unknown): PayoutNotification | null {
    const parsed = FlutterwaveTransferSchema.safeParse(body);
    if (!parsed.success) return null;
    const b = parsed.data;
    if (!b.event?.startsWith("transfer.")) return null;
    const d = b.data;
    const status =
      d.status === "SUCCESSFUL" ? "successful" : d.status === "FAILED" ? "failed" : null;
    if (!status) return null;
    return {
      reference: d.reference ?? "",
      status,
      providerRef: d.flw_ref,
      provider: "flutterwave",
      raw: body,
    };
  },

  async getTransferStatus(reference: string): Promise<TransferStatus> {
    try {
      const res = await api<any>("GET", `/transfers/${encodeURIComponent(reference)}/verify`);
      const d = res.data;
      const status: TransferStatus["status"] =
        d.status === "SUCCESSFUL"
          ? "successful"
          : d.status === "FAILED"
            ? "failed"
            : d.status === "PENDING" || d.status === "PENDING_APPROVAL"
              ? "pending"
              : "unknown";
      return { status, providerRef: d.flw_ref };
    } catch (err: any) {
      return { status: "unknown", error: String(err?.message ?? err) };
    }
  },

  async createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountData> {
    const res = await api<{
      data: {
        account_number: string;
        bank_name: string;
        bank_code: string;
        account_name: string;
        reference: string;
        flw_ref: string;
      };
    }>("POST", "/virtual-account-numbers", {
      email: `${params.phone}@coop.placeholder`,
      tx_ref: params.reference,
      amount: 1, // minimal amount for VA creation
      currency: params.currency ?? "NGN",
      narration: `Virtual account for ${params.name}`,
      frequency: "daily",
      duration: 365,
      is_permanent: true,
    });
    const d = res.data;
    return {
      accountNumber: d.account_number,
      bank: d.bank_name,
      provider: "flutterwave",
      providerRef: d.flw_ref,
    };
  },

  async resolveAccount(params: ResolveAccountParams): Promise<ResolveAccountResult> {
    try {
      const res = await api<{
        data: { account_name: string; account_number: string; bank_code: string };
      }>("POST", "/accounts/resolve", {
        account_number: params.accountNumber,
        account_bank: params.bankCode,
      });
      return { ok: true, name: res.data.account_name };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "account resolution failed" };
    }
  },

  async listBanks(currency?: string): Promise<Bank[]> {
    try {
      const country = countryForCurrency(currency ?? "NGN");
      const res = await api<{ data: Array<{ code: string; name: string }> }>(
        "GET",
        `/banks/${country}`,
      );
      if (!Array.isArray(res.data)) return [];
      return res.data
        .map((b) => ({ code: String(b.code ?? ""), name: String(b.name ?? "") }))
        .filter((b: Bank) => b.code && b.name);
    } catch {
      return [];
    }
  },

  async payout(params: PayoutParams): Promise<PayoutResult> {
    try {
      const res = await api<{
        data: {
          id: string;
          reference: string;
          flw_ref: string;
          status: string;
        };
      }>("POST", "/transfers", {
        account_bank: params.bankCode,
        account_number: params.bankAccountNumber,
        amount: forProvider(params.amount, "flutterwave"),
        currency: params.currency ?? "NGN",
        reference: params.reference,
        narration: `Transfer to ${params.recipientName} (${params.reference.slice(-8)})`,
        beneficiary_name: params.recipientName,
      });
      const d = res.data;
      return {
        ok: d.status === "SUCCESSFUL",
        providerRef: d.flw_ref,
        error: d.status === "SUCCESSFUL" ? undefined : "Transfer failed",
      };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "payout failed" };
    }
  },
};
