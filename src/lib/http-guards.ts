/**
 * Decide whether a request must be rejected for arriving over plain HTTP.
 *
 * The app sits behind Caddy, which sets `x-forwarded-proto`. Container-local
 * liveness probes (Docker HEALTHCHECK, compose healthcheck) hit `/health` over
 * plain HTTP inside the network, so that endpoint is exempt; everything else
 * must arrive as HTTPS when production enforcement is on.
 */
export function isInsecureRequest(url: string, forwardedProto: string | undefined): boolean {
  if (url === "/health" || url.startsWith("/health?")) return false;
  return forwardedProto !== "https";
}
