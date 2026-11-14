/**
 * Resolve Fastify's `trustProxy` option.
 *
 * `trustProxy: true` trusts EVERY hop in `X-Forwarded-For`, so any client can
 * forge its own address and bypass IP-based rate limits (including the login
 * limits). This Fastify build also fails closed on a bare hop count, so the
 * safe, supported form is an address list that matches the actual proxy:
 * the app is reached from loopback (same host / docker-compose Caddy) or from
 * link-local / private (RFC1918, ULA) addresses (Render's edge, compose
 * networks). Internet clients cannot present those source addresses, so their
 * X-Forwarded-* values are never trusted.
 *
 * Set TRUST_PROXY to override:
 *   - "false" / "0"        → trust nothing
 *   - "true"               → trust everything (explicit opt-in; only when the
 *                            app is unreachable except through your proxy)
 *   - CIDR / preset list    → proxy-addr notation, e.g.
 *                            "10.0.0.0/8, 172.16.0.0/12"
 */
export const DEFAULT_TRUST_PROXY = "loopback, linklocal, uniquelocal";

export function resolveTrustProxy(raw: string | undefined): boolean | string {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRUST_PROXY;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false" || value === "0") return false;
  // A bare number is not a supported trust spec here (and would fail closed).
  if (/^\d+$/.test(value)) return DEFAULT_TRUST_PROXY;
  return raw.trim();
}
