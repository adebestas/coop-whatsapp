/**
 * VTU airtime adapter (Flutterwave) — unit tests.
 *
 * The adapter is exercised against the REAL Flutterwave request shapes with
 * `global.fetch` stubbed (mirrors tests/bank-picker.test.ts). We cover:
 *  - kobo -> naira conversion and the bill-payment request body
 *  - phone prefix -> mobile network mapping
 *  - runtime biller discovery, cached for 24h (a second recharge does not re-fetch)
 *  - success returns a providerRef; non-success / unknown network do not throw
 *  - `resolveVtuProvider()` gating on VTU_PROVIDER + secret
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVtuProvider, clearVtuBillerCache, networkForPhone } from "../src/services/payments/vtu.js";

const FLW = "https://api.flutterwave.com/v3";

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const CATEGORIES = {
  status: "success",
  message: "Categories fetched successfully",
  data: [
    { id: 1, name: "Airtime", code: "AIRTIME", description: "Airtime", country_code: "NG" },
    { id: 2, name: "Mobile Data Service", code: "MOBILEDATA", country_code: "NG" },
    // A GH airtime category must NOT be selected.
    { id: 10, name: "Airtime", code: "AIRTIME", country_code: "GH" },
  ],
};

const BILLERS = {
  status: "success",
  message: "Billers fetched successfully",
  data: [
    { id: 1, name: "MTN", short_name: "MTN", biller_code: "BIL100", country_code: "NG" },
    { id: 2, name: "GLO", short_name: "Glo", biller_code: "BIL101", country_code: "NG" },
    { id: 3, name: "Airtel Nigeria", short_name: "Airtel", biller_code: "BIL102", country_code: "NG" },
    { id: 4, name: "9MOBILE", short_name: "9mobile", biller_code: "BIL103", country_code: "NG" },
    // A cable biller in the same list must be ignored.
    { id: 5, name: "DSTV", short_name: "DSTV", biller_code: "BIL119", country_code: "NG" },
  ],
};

const ITEMS: Record<string, unknown> = {
  BIL100: {
    status: "success",
    data: [
      { id: 1, biller_code: "BIL100", name: "MTN Airtime", is_airtime: true, item_code: "AT100", category_name: "Airtime" },
    ],
  },
  BIL101: {
    status: "success",
    data: [
      { id: 2, biller_code: "BIL101", name: "Glo Airtime", is_airtime: true, item_code: "AT101", category_name: "Airtime" },
    ],
  },
  BIL102: {
    status: "success",
    data: [
      { id: 3, biller_code: "BIL102", name: "Airtel Airtime", is_airtime: true, item_code: "AT102", category_name: "Airtime" },
    ],
  },
  BIL103: {
    status: "success",
    data: [
      { id: 4, biller_code: "BIL103", name: "9mobile Airtime", is_airtime: true, item_code: "AT103", category_name: "Airtime" },
    ],
  },
  BIL119: {
    status: "success",
    data: [{ id: 5, biller_code: "BIL119", name: "DSTV", is_airtime: false, item_code: "CB140" }],
  },
};

const SUCCESS_PAYMENT = {
  status: "success",
  message: "Bill payment successful",
  data: {
    phone_number: "08031234567",
    amount: 500,
    network: "MTN",
    code: "200",
    tx_ref: "CF-FLYAPI-2026",
    reference: "247891569224",
    fee: 0,
  },
};

/**
 * Stub `global.fetch` with the real Flutterwave discovery + payment routing.
 * Options let a test simulate network throws, unparseable bodies, and partial
 * biller discovery.
 */
interface FlwStubOptions {
  /** Override the bill-payment JSON body. */
  payment?: () => unknown;
  /** Reject the payment fetch itself (simulates a network error / timeout). */
  paymentThrows?: boolean;
  /** Make the payment response's `.json()` reject (unparseable body). */
  jsonThrows?: boolean;
  /** HTTP status for the payment response (default 200). */
  paymentStatus?: number;
  /** Override the discovered billers (to simulate partial/empty discovery). */
  billers?: unknown[];
}

function stubFlw(opts: FlwStubOptions = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/top-bill-categories")) return json(CATEGORIES);
    if (/\/bills\/AIRTIME\/billers/.test(url)) {
      return json({ ...BILLERS, data: opts.billers ?? BILLERS.data });
    }
    const item = url.match(/\/billers\/([^/]+)\/items$/);
    if (item) return json(ITEMS[item[1]] ?? { status: "success", data: [] });
    if (url.includes("/payment")) {
      if (opts.paymentThrows) throw new Error("socket hang up");
      if (opts.jsonThrows) {
        return {
          ok: false,
          status: opts.paymentStatus ?? 502,
          json: async () => {
            throw new Error("invalid json");
          },
        };
      }
      return {
        ok: true,
        status: opts.paymentStatus ?? 200,
        json: async () => (opts.payment ? opts.payment() : SUCCESS_PAYMENT),
      };
    }
    return json({ status: "error", message: "unexpected url" });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function paymentCall(calls: Array<{ url: string; init?: RequestInit }>) {
  const call = calls.find((c) => c.url.includes("/payment"));
  expect(call).toBeDefined();
  return { url: call!.url, body: JSON.parse(String(call!.init?.body)) as Record<string, unknown> };
}

beforeEach(() => {
  delete process.env.VTU_PROVIDER;
  delete process.env.FLUTTERWAVE_SECRET_KEY;
  delete process.env.VTU_API_KEY;
  clearVtuBillerCache();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function arm() {
  process.env.VTU_PROVIDER = "flutterwave";
  process.env.FLUTTERWAVE_SECRET_KEY = "FLWSECK_TEST-abc";
}

describe("resolveVtuProvider", () => {
  it("returns null when nothing is configured", () => {
    expect(resolveVtuProvider()).toBeNull();
  });

  it("returns null when the provider is set but no secret is available", () => {
    process.env.VTU_PROVIDER = "flutterwave";
    expect(resolveVtuProvider()).toBeNull();
  });

  it("returns null for an unknown provider name", () => {
    process.env.VTU_PROVIDER = "nope";
    process.env.FLUTTERWAVE_SECRET_KEY = "FLWSECK_TEST-abc";
    expect(resolveVtuProvider()).toBeNull();
  });

  it("returns a flutterwave provider when VTU_PROVIDER + secret are set", () => {
    arm();
    const provider = resolveVtuProvider();
    expect(provider?.name).toBe("flutterwave");
  });

  it("falls back to VTU_API_KEY when FLUTTERWAVE_SECRET_KEY is unset", () => {
    process.env.VTU_PROVIDER = "flutterwave";
    process.env.VTU_API_KEY = "legacy-key";
    expect(resolveVtuProvider()?.name).toBe("flutterwave");
  });
});

describe("phone prefix -> network", () => {
  it("maps the major NG prefixes to their networks", () => {
    expect(networkForPhone("08031234567")).toBe("MTN");
    expect(networkForPhone("08051234567")).toBe("GLO");
    expect(networkForPhone("08021234567")).toBe("AIRTEL");
    expect(networkForPhone("08091234567")).toBe("9MOBILE");
  });

  it("normalises +234 / 234 / bare 10-digit forms", () => {
    expect(networkForPhone("+2348031234567")).toBe("MTN");
    expect(networkForPhone("2348031234567")).toBe("MTN");
    expect(networkForPhone("8031234567")).toBe("MTN");
  });

  it("returns null for an unknown prefix", () => {
    expect(networkForPhone("05551234567")).toBeNull();
    expect(networkForPhone("")).toBeNull();
  });
});

describe("flutterwave recharge", () => {
  it("converts kobo to naira and posts the bill payment body", async () => {
    arm();
    const calls = stubFlw();
    const provider = resolveVtuProvider()!;

    const res = await provider.recharge({
      phone: "08031234567",
      amountKobo: 50123,
      reference: "REFERRAL-abc",
    });

    expect(res.ok).toBe(true);
    expect(res.providerRef).toBe("CF-FLYAPI-2026");

    const { url, body } = paymentCall(calls);
    expect(url).toBe(`${FLW}/billers/BIL100/items/AT100/payment`);
    expect(body).toEqual({
      country: "NG",
      customer_id: "08031234567",
      amount: 501,
      reference: "REFERRAL-abc",
    });
  });

  it("routes each network to its own biller + airtime item", async () => {
    arm();
    const calls = stubFlw();
    const provider = resolveVtuProvider()!;

    await provider.recharge({ phone: "08031234567", amountKobo: 50000, reference: "r-mtn" });
    await provider.recharge({ phone: "08051234567", amountKobo: 50000, reference: "r-glo" });
    await provider.recharge({ phone: "08021234567", amountKobo: 50000, reference: "r-airtel" });
    await provider.recharge({ phone: "08091234567", amountKobo: 50000, reference: "r-9mobile" });

    const paymentUrls = calls.filter((c) => c.url.includes("/payment")).map((c) => c.url);
    expect(paymentUrls).toEqual([
      `${FLW}/billers/BIL100/items/AT100/payment`,
      `${FLW}/billers/BIL101/items/AT101/payment`,
      `${FLW}/billers/BIL102/items/AT102/payment`,
      `${FLW}/billers/BIL103/items/AT103/payment`,
    ]);
    // The DSTV biller must never be used for airtime.
    expect(paymentUrls.some((u) => u.includes("BIL119"))).toBe(false);
  });

  it("caches biller discovery for 24h (a second recharge does not re-fetch billers)", async () => {
    arm();
    const calls = stubFlw();
    const provider = resolveVtuProvider()!;

    await provider.recharge({ phone: "08031234567", amountKobo: 50000, reference: "r1" });
    const billerFetches1 = calls.filter((c) => c.url.includes("/bills/AIRTIME/billers")).length;
    const itemFetches1 = calls.filter((c) => /\/items$/.test(c.url)).length;
    expect(billerFetches1).toBe(1);
    expect(itemFetches1).toBe(4);

    await provider.recharge({ phone: "08051234567", amountKobo: 50000, reference: "r2" });

    expect(calls.filter((c) => c.url.includes("/top-bill-categories")).length).toBe(1);
    expect(calls.filter((c) => c.url.includes("/bills/AIRTIME/billers")).length).toBe(1);
    expect(calls.filter((c) => /\/items$/.test(c.url)).length).toBe(itemFetches1);
    // But a second payment was made.
    expect(calls.filter((c) => c.url.includes("/payment")).length).toBe(2);
  });

  it("returns ok:false (never throws) on a non-success response", async () => {
    arm();
    stubFlw({ payment: () => ({ status: "error", message: "Insufficient balance", data: null }) });
    const provider = resolveVtuProvider()!;

    const res = await provider.recharge({
      phone: "08031234567",
      amountKobo: 50000,
      reference: "r-fail",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("Insufficient balance");
    // A clear, non-duplicate error is a DEFINITE failure — safe to retry.
    expect(res.unsure).toBeUndefined();
  });

  it("does NOT cache a partial discovery (a second call re-discovers)", async () => {
    arm();
    // Only MTN + GLO are discoverable: an incomplete map must not be cached for
    // 24h, which would silently kill airtime for the other networks.
    const partial = BILLERS.data.filter((b) => b.name === "MTN" || b.name === "GLO");
    const calls = stubFlw({ billers: partial });
    const provider = resolveVtuProvider()!;

    const first = await provider.recharge({
      phone: "08031234567",
      amountKobo: 50000,
      reference: "p1",
    });
    expect(first.ok).toBe(true);
    // A network missing from the partial map fails cleanly...
    const missing = await provider.recharge({
      phone: "08021234567",
      amountKobo: 50000,
      reference: "p2",
    });
    expect(missing.ok).toBe(false);

    // ...and BOTH recharges re-ran discovery because nothing was cached.
    expect(calls.filter((c) => c.url.includes("/bills/AIRTIME/billers")).length).toBe(2);
    expect(calls.filter((c) => c.url.includes("/top-bill-categories")).length).toBe(2);
  });

  it("marks a thrown payment request as unsure (outcome unknown)", async () => {
    arm();
    stubFlw({ paymentThrows: true });
    const provider = resolveVtuProvider()!;

    const res = await provider.recharge({
      phone: "08031234567",
      amountKobo: 50000,
      reference: "r",
    });

    expect(res.ok).toBe(false);
    expect(res.unsure).toBe(true);
  });

  it("marks a duplicate-reference error as unsure (the first payment may have landed)", async () => {
    arm();
    stubFlw({
      payment: () => ({ status: "error", message: "Duplicate transaction reference", data: null }),
    });
    const provider = resolveVtuProvider()!;

    const res = await provider.recharge({
      phone: "08031234567",
      amountKobo: 50000,
      reference: "r",
    });

    expect(res.ok).toBe(false);
    expect(res.unsure).toBe(true);
    expect(res.error).toContain("Duplicate");
  });

  it("marks a success without a tx_ref as unsure (no confirmed provider ref)", async () => {
    arm();
    stubFlw({ payment: () => ({ status: "success", message: "ok", data: { reference: "2478" } }) });
    const provider = resolveVtuProvider()!;

    const res = await provider.recharge({
      phone: "08031234567",
      amountKobo: 50000,
      reference: "r",
    });

    expect(res.ok).toBe(false);
    expect(res.unsure).toBe(true);
  });

  it("marks a non-200 / unparseable payment response as unsure (ambiguous)", async () => {
    arm();
    stubFlw({ jsonThrows: true, paymentStatus: 502 });
    const provider = resolveVtuProvider()!;

    const res = await provider.recharge({
      phone: "08031234567",
      amountKobo: 50000,
      reference: "r",
    });

    expect(res.ok).toBe(false);
    expect(res.unsure).toBe(true);
  });

  it("returns ok:false for an unknown network without calling the API", async () => {
    arm();
    const calls = stubFlw();
    const provider = resolveVtuProvider()!;

    const res = await provider.recharge({
      phone: "05551234567",
      amountKobo: 50000,
      reference: "r-unknown",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/network|mobile number/i);
    expect(calls.length).toBe(0);
  });
});
