import type {
  CreateVirtualAccountParams,
  PayoutParams,
  PayoutResult,
  PaymentNotification,
  ProviderAdapter,
  ResolveAccountParams,
  ResolveAccountResult,
  VirtualAccountData,
  TransferStatus,
} from "./index.js";
import { signaturesMatch } from "./index.js";

const API_BASE = "https://api.flutterwave.com/v3";

function getSecret(): string {
  const key = process.env.FLUTTERWAVE_SECRET_KEY ?? "";
  if (!key) {
    throw new Error("FLUTTERWAVE_SECRET_KEY is not set");
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
  if (!res.ok || json.status !== "success") {
    throw new Error(`Flutterwave ${method} ${path} failed: ${JSON.stringify(json)}`);
  }
  return json as T;
}

/**
 * Flutterwave virtual account numbers.
 * Flow: create customer -> create permanent virtual account with the customer token.
 */
export const flutterwaveAdapter: ProviderAdapter = {
  name: "flutterwave",

  async resolveAccount(params: ResolveAccountParams): Promise<ResolveAccountResult> {
    try {
      const res = await api<any>("/accounts/resolve", "POST", {
        account_number: params.accountNumber,
        account_bank: params.bankCode,
      });
      return { ok: true, name: res.data?.account_name ?? undefined };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "account resolution failed" };
    }
  },

  async payout(params: PayoutParams): Promise<PayoutResult> {
    try {
      const res = await api<any>("/transfers", "POST", {
        account_bank: params.bankCode,
        account_number: params.bankAccountNumber,
        amount: params.amount,
        currency: params.currency ?? "NGN",
        narration: `Coop payout ${params.reference}`,
        reference: params.reference,
        beneficiary_name: params.recipientName,
      });
      return { ok: true, providerRef: res.data?.id ? String(res.data.id) : undefined };
    } catch (err: any) {
      return { ok: false, error: err.message ?? "payout failed" };
    }
  },

  async createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountData> {
    const cust = await api<any>("/customers", "POST", {
      email: `${params.reference}@coop.local`,
      phone_number: params.phone,
      name: params.name,
    });
    const customerToken = cust.data?.id;
    if (!customerToken) throw new Error("Flutterwave customer creation returned no id");

    const va = await api<any>("/virtual-account-numbers", "POST", {
      email: `${params.reference}@coop.local`,
      is_permanent: true,
      amount: 0,
      currency: params.currency ?? "NGN",
      tx_ref: params.reference,
    });

    return {
      accountNumber: va.data?.account_number,
      bank: va.data?.bank_name ?? "Flutterwave",
      provider: "flutterwave",
      providerRef: String(customerToken),
    };
  },

  verifyWebhook(rawBody, headers): boolean {
    // Flutterwave webhooks carry a static secret hash in the `verif-hash`
    // header (set in the dashboard). FAIL CLOSED: if FLUTTERWAVE_WEBHOOK_HASH
    // is not configured, every webhook is rejected — an unauthenticated
    // "verify everything" adapter once let forged credits mint wallet money.
    const expected = process.env.FLUTTERWAVE_WEBHOOK_HASH ?? "";
    const received = String(headers["verif-hash"] ?? "");
    if (!expected || !received) return false;
    return signaturesMatch(expected, received);
  },

  parseNotification(body: any): PaymentNotification | null {
    if (!body || !body.data) return null;
    const d = body.data;

    // We only care about successful virtual-account credits.
    const isCredit =
      body.event === "charge.completed" ||
      body.event === "payment_request.completed" ||
      body.event === "virtual_card.transaction";
    if (!isCredit) return null;
    if (d.status !== "successful" && d.status !== "success") return null;

    const amount = Number(d.amount ?? d.charged_amount ?? 0);
    return {
      transactionId: String(d.id ?? d.transaction_id ?? Date.now()),
      reference: d.tx_ref ?? d.reference,
      accountNumber: String(d.account_number ?? ""),
      amount,
      currency: d.currency ?? "NGN",
      status: "successful",
      provider: "flutterwave",
      raw: body,
    };
  },

  async getTransferStatus(reference) {
    try {
      // Flutterwave v3 supports lookup by our own transfer reference.
      const res = await api<{ data?: any }>("GET", `/transfers?reference=${encodeURIComponent(reference)}`);
      const d = Array.isArray(res.data) ? res.data[0] : res.data;
      const s = String(d?.status ?? "").toLowerCase();
      const status: TransferStatus["status"] =
        s === "successful"
          ? "successful"
          : s === "failed" || s === "reversed" || s === "cancelled"
            ? "failed"
            : s === "processing" || s === "pending" || s === "new" || s === "ongoing"
              ? "pending"
              : "unknown";
      return { status, providerRef: d?.id != null ? String(d.id) : undefined };
    } catch (err: any) {
      return { status: "unknown", error: String(err?.message ?? err) };
    }
  },
};