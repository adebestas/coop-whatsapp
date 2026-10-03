import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/lib/logger.js";

describe("logger error forwarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ERROR_WEBHOOK_URL;
  });

  it("forwards errors to ERROR_WEBHOOK_URL when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    process.env.ERROR_WEBHOOK_URL = "https://example.test/hook";

    log.error("boom", { a: 1 });
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://example.test/hook");
    expect(JSON.parse(init.body).text).toContain("boom");
  });

  it("does not forward when ERROR_WEBHOOK_URL is unset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.ERROR_WEBHOOK_URL;

    log.error("boom");
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the webhook fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    process.env.ERROR_WEBHOOK_URL = "https://example.test/hook";

    expect(() => log.error("boom")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});
