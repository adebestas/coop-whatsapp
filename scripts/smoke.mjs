#!/usr/bin/env node
/**
 * Post-deploy smoke check. Render's deploy hook returns as soon as the build is
 * queued, so the pipeline polls the live URL until the new instance answers.
 *
 * Usage: node scripts/smoke.mjs https://staging.example.com [--timeout=300]
 * Exit codes: 0 healthy, 1 unhealthy, 2 usage/configuration error.
 */
const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--"));
const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const timeoutSeconds = timeoutArg ? Number(timeoutArg.split("=")[1]) : 300;

if (!base || !/^https?:\/\//.test(base) || !Number.isFinite(timeoutSeconds)) {
  console.error("usage: node scripts/smoke.mjs <https://base-url> [--timeout=300]");
  process.exit(2);
}

const deadline = Date.now() + timeoutSeconds * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe() {
  const res = await fetch(new URL("/health", base), {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  return { status: res.status, body };
}

let lastError = "no attempt made";
while (Date.now() < deadline) {
  try {
    const { status, body } = await probe();
    if (status === 200 && /"status"\s*:\s*"ok"/.test(body)) {
      console.log(`smoke: ${base}/health is ok`);
      process.exit(0);
    }
    lastError = `HTTP ${status}: ${body.slice(0, 200)}`;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
  await sleep(10_000);
}

console.error(`smoke: ${base} did not become healthy within ${timeoutSeconds}s (${lastError})`);
process.exit(1);
