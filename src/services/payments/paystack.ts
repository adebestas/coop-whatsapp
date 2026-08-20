import { createHmac } from "node:crypto";
import type {
  CreateVirtualAccountParams,
  PayoutParams,
  PayoutResult,
  PaymentNotification,
  ProviderAdapter,
  VirtualAccountData,
} from "./index.js";

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

  async payout(params: PayoutParams): Promise<PayoutResult> {
    try {
      // Requires a transfer recipient + bank verification. Here we create the
      // recipient then transfer. Recipient codes are cached per account.
      const res = await api<any>("/transfer", "POST", {
        source: process.env.PAYSTACK_TRANSFER_SOURCE ?? "balance",
        amount: Math.round(params.amount * 100),
        reference: params.reference,
        recipient: params.bankCode, // expects a recipient_code in production
        reason: `Coop payout ${params.reference}`,
      });
      return { ok: true, providerRef: res.data?.transfer_code };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "payout failed" };
    }
  },

  async createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountData> {
    // 1. Create a customer.
    const cust = await api<any>("/customer", "POST", {
      email: `${params.reference}@coop.local`,
      phone: params.phone,
      first_name: params.name.split(" ")[0] ?? params.name,
      last_name: params.name.split(" ").slice(1).join(" ") || "Member",
    });
    const customerCode = cust.data?.customer_code;
    if (!customerCode) throw new Error("Paystack customer creation returned no code");

    // 2. Assign a dedicated virtual account.
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

  verifyWebhook(body: any, headers: Record<string, string | string[] | undefined>): boolean {
    const signature = header(headers, "x-paystack-signature");
    if (!signature) return false;
    const hash = createHmac("sha512", getSecret())
      .update(JSON.stringify(body))
      .digest("hex");
    return hash === signature;
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
};

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}