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
 * Set TRUST_PROXY to override (TRUST_PROXY_HOPS is still accepted as an alias\n * for deployments configured against the older variable name):
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
export type TrustProxyEnv = { TRUST_PROXY?: string; TRUST_PROXY_HOPS?: string };

/**
 * Read the override from the environment. TRUST_PROXY is the documented
 * name; TRUST_PROXY_HOPS is kept as an alias so existing deployments keep
 * their topology. A blank TRUST_PROXY is treated as unset rather than as
 * "trust nothing", because that is what an unset variable means.
 */
export function resolveTrustProxyFromEnv(env: TrustProxyEnv = process.env): boolean | string {
  const primary = env.TRUST_PROXY;
  if (primary !== undefined && primary.trim() !== "") return resolveTrustProxy(primary);
  return resolveTrustProxy(env.TRUST_PROXY_HOPS);
}
