import { createHmac } from "node:crypto";
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

const API_BASE = "https://api.paystack.co";

function getSecret(): string {
  const key = process.env.PAYSTACK_SECRET_KEY ?? "";
  if (!key) {
    throw new Error("PAYSTACK_SECRET_KEY is not set");
  }
  return key;
}

async function api<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getSecret()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  if (!res.ok || json.status !== true) {
    throw new Error(`Paystack ${method} ${path} failed: ${JSON.stringify(json)}`);
  }
  return json as T;
}

/**
 * Paystack Dedicated Virtual Account (DVA).
 * NOTE: DVA requires a KYC-tiered business account + DVASP provider configured
 * in the Paystack dashboard, and provisioning has a fee. See:
 * https://paystack.com/docs/payments/dedicated-virtual-accounts/
 */
export const paystackAdapter: ProviderAdapter = {
  name: "paystack",

  async resolveAccount(params: ResolveAccountParams): Promise<ResolveAccountResult> {
    try {
      const res = await api<any>(
        `/bank/resolve?account_number=${encodeURIComponent(params.accountNumber)}&bank_code=${encodeURIComponent(params.bankCode)}`,
        "GET",
      );
      return { ok: true, name: res.data?.account_name ?? undefined };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "account resolution failed" };
    }
  },

  async payout(params: PayoutParams): Promise<PayoutResult> {
    try {
      // 1. Check for existing recipient to avoid duplicates
      let recipientCode: string | undefined;
      try {
        const listRes = await api<any>(
          `/transferrecipient?account_number=${encodeURIComponent(params.bankAccountNumber)}&bank_code=${encodeURIComponent(params.bankCode)}&currency=NGN`,
          "GET",
        );
        const existing = listRes.data?.find(
          (r: any) =>
            r.account_number === params.bankAccountNumber &&
            r.bank_code === params.bankCode &&
            r.currency === "NGN" &&
            r.active,
        );
        if (existing?.recipient_code) {
          recipientCode = existing.recipient_code;
        }
      } catch {
        // If listing fails, proceed to create a new one
      }

      // 2. Create transfer recipient if none found
      if (!recipientCode) {
        const recipientRes = await api<any>("/transferrecipient", "POST", {
          type: "nuban",
          name: params.recipientName || "Coop Member",
          account_number: params.bankAccountNumber,
          bank_code: params.bankCode,
          currency: "NGN",
        });
        recipientCode = recipientRes.data?.recipient_code;
      }
      if (!recipientCode) {
        return { ok: false, error: "Failed to create Paystack transfer recipient" };
      }

      // 2. Initiate transfer with recipient code
      const res = await api<any>("/transfer", "POST", {
        source: process.env.PAYSTACK_TRANSFER_SOURCE ?? "balance",
        amount: forProvider(params.amount, "paystack"),
        reference: params.reference,
        recipient: recipientCode, // ✅ Correct: recipient_code, not bank_code
        reason: `Coop payout ${params.reference}`,
      });
      return { ok: true, providerRef: res.data?.transfer_code };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "payout failed" };
    }
  },

  async createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountData> {
    // 1. Check if customer already exists by email reference.
    const existingEmail = `${params.reference}@coop.local`;
    let customerCode: string;
    try {
      const searchRes = await api<any>(`/customer/${encodeURIComponent(existingEmail)}`, "GET");
      customerCode = searchRes.data?.customer_code;
    } catch {
      customerCode = "";
    }

    // 2. Create customer only if not found.
    if (!customerCode) {
      const cust = await api<any>("/customer", "POST", {
        email: existingEmail,
        phone: params.phone,
        first_name: params.name.split(" ")[0] ?? params.name,
        last_name: params.name.split(" ").slice(1).join(" ") || "Member",
      });
      customerCode = cust.data?.customer_code;
      if (!customerCode) throw new Error("Paystack customer creation returned no code");
    }

    // 3. Assign a dedicated virtual account.
    const dva = await api<any>("/dedicated_account", "POST", {
      customer: customerCode,
      preferred_bank: process.env.PAYSTACK_PREFERRED_BANK,
    });

    const assignment = dva.data?.assignments?.[0] ?? {};
    return {
      accountNumber: assignment.account_number,
      bank: dva.data?.bank?.name ?? "Paystack",
      provider: "paystack",
      providerRef: customerCode,
    };
  },

  verifyWebhook(rawBody, headers): boolean {
    // Paystack signs the RAW request body with HMAC-SHA512 using the secret key.
    const signature = header(headers, "x-paystack-signature");
    if (!signature || typeof rawBody !== "string" || rawBody.length === 0) return false;
    let secret: string;
    try {
      secret = getSecret();
    } catch {
      return false; // fail closed when unconfigured
    }
    const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
    return signaturesMatch(expected, signature);
  },

  parseNotification(body: any): PaymentNotification | null {
    if (!body || !body.data) return null;
    const d = body.data;

    // charge.success fires for transfers into dedicated accounts.
    if (body.event !== "charge.success") return null;
    if (d.status !== "success" && d.status !== "successful") return null;

    const amountKobo = Number(d.amount ?? 0);
    return {
      transactionId: String(d.id ?? d.transaction_id ?? Date.now()),
      reference: d.reference,
      accountNumber: String(d.account?.number ?? ""),
      amount: amountKobo / 100, // Paystack amounts are in kobo/cents
      currency: d.currency ?? "NGN",
      status: "successful",
      provider: "paystack",
      raw: body,
    };
  },

  async getTransferStatus(reference) {
    try {
      const res = await api<{ data?: { status?: string; id?: number | string; transfer_code?: string } }>(
        `/transfer/verify/${encodeURIComponent(reference)}`,
        "GET",
      );
      const s = String(res.data?.status ?? "").toLowerCase();
      const status: TransferStatus["status"] =
        s === "success"
          ? "successful"
          : s === "failed" || s === "reversed"
            ? "failed"
            : s === "processing" || s === "pending" || s === "otp"
              ? "pending"
              : "unknown";
      return {
        status,
        providerRef: res.data?.transfer_code ?? (res.data?.id != null ? String(res.data.id) : undefined),
      };
    } catch (err: any) {
      // Unconfigured or HTTP error — treat as unknown, never guess.
      return { status: "unknown", error: String(err?.message ?? err) };
    }
  },
};

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}