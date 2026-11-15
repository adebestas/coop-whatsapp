/**
 * SEC-P1: `trustProxy: true` trusts every X-Forwarded-For hop, so a client can
 * forge its own IP and walk around IP-based login rate limits. The app sits
 * behind a single proxy, so trust is limited to the proxy's source addresses
 * (loopback / link-local / private), never to arbitrary internet clients.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_TRUST_PROXY, resolveTrustProxy } from "../src/lib/trust-proxy.js";

describe("resolveTrustProxy", () => {
  it("trusts only loopback / link-local / private proxy addresses by default", () => {
    expect(resolveTrustProxy(undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(resolveTrustProxy("")).toBe(DEFAULT_TRUST_PROXY);
    expect(DEFAULT_TRUST_PROXY).toContain("loopback");
    expect(DEFAULT_TRUST_PROXY).toContain("uniquelocal");
  });

  it("supports explicit disable and explicit trust-all", () => {
    expect(resolveTrustProxy("false")).toBe(false);
    expect(resolveTrustProxy("0")).toBe(false);
    expect(resolveTrustProxy("true")).toBe(true);
  });

  it("accepts a proxy-address list", () => {
    expect(resolveTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toBe("10.0.0.0/8, 172.16.0.0/12");
    expect(resolveTrustProxy("loopback")).toBe("loopback");
  });

  it("falls back to the safe default for unsupported trust specs", () => {
    // This Fastify build fails closed on a numeric hop count, which would also
    // make the production HTTPS guard reject every request — so never use it.
    expect(resolveTrustProxy("1")).toBe(DEFAULT_TRUST_PROXY);
    expect(resolveTrustProxy("2")).toBe(DEFAULT_TRUST_PROXY);
  });
});
