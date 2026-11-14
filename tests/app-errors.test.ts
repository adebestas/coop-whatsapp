/**
 * Support-grade error envelope + PII-safe logging.
 *
 * A member reporting "it just said error" must be resolvable from one line: the
 * response carries a requestId that also appears in the server log. And log
 * metadata must never persist raw phone numbers, PINs, or tokens.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { log } from "../src/lib/logger.js";

describe("global error envelope", () => {
  let app: ReturnType<typeof buildApp>;

  afterEach(async () => {
    await app?.close();
  });

  it("returns a generic 500 with a requestId and does not leak internals", async () => {
    app = buildApp();
    app.get("/__test/boom", async () => {
      throw new Error("secret internal detail");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/__test/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: string; requestId: string };
    expect(body.error).toBe("Something went wrong. Please try again.");
    expect(body.error).not.toContain("secret internal detail");
    expect(body.requestId).toBeTruthy();
  });

  it("keeps client-error messages and still attaches a requestId", async () => {
    app = buildApp();
    app.get("/__test/teapot", async () => {
      const err = new Error("Add a valid cooperative code") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/__test/teapot" });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; requestId: string };
    expect(body.error).toBe("Add a valid cooperative code");
    expect(body.requestId).toBeTruthy();
  });
});

describe("logger redaction", () => {
  it("redacts PII and credentials from log metadata but keeps safe fields", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    log.info("member lookup", {
      phone: "2348033334444",
      pin: "1234",
      nested: { token: "tok_live_abc", note: "kept" },
      accountNumber: "0123456789",
      cooperativeId: "coop_123",
    });

    const line = write.mock.calls.map((c) => String(c[0])).join("");
    expect(line).not.toContain("2348033334444");
    expect(line).not.toContain("1234");
    expect(line).not.toContain("tok_live_abc");
    expect(line).not.toContain("0123456789");
    expect(line).toContain("coop_123");
    expect(line).toContain("kept");

    write.mockRestore();
  });
});
