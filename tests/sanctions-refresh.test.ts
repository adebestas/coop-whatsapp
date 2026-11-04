import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { cleanupDatabase } from "./setup.js";
import {
  getSanctionsRefreshStatus,
  refreshSanctionsList,
} from "../src/services/sanctions-refresh.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sanctions watchlist refresh", () => {
  const originalUrl = process.env.SANCTIONS_LIST_URL;

  beforeEach(async () => {
    delete process.env.SANCTIONS_LIST_URL;
    await cleanupDatabase();
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SANCTIONS_LIST_URL;
    else process.env.SANCTIONS_LIST_URL = originalUrl;
  });

  it("records a failed refresh when no feed is configured", async () => {
    const result = await refreshSanctionsList();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("SANCTIONS_LIST_URL");
    const status = await getSanctionsRefreshStatus();
    expect(status?.status).toBe("failed");
    expect(status?.error).toContain("SANCTIONS_LIST_URL");
  });

  it("upserts entries, deactivates stale names and stores the timestamp", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [
            { name: "Ivan Petrov", listType: "sanction", country: "RU", aliases: ["I. Petrov"] },
            { name: "Grace Okoro", listType: "pep", country: "NG" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [
            { name: "Ivan Petrov", listType: "sanction", country: "RU" },
            { name: "Ade Bello", listType: "sanction", country: "NG" },
          ],
        }),
      );

    const first = await refreshSanctionsList({
      sourceUrl: "https://lists.example.test/v1/sanctions",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(first.ok).toBe(true);
    expect(first.created).toBe(2);
    expect(first.updated).toBe(0);
    expect(await prisma.sanctionsEntry.count({ where: { isActive: true } })).toBe(2);

    const second = await refreshSanctionsList({
      sourceUrl: "https://lists.example.test/v1/sanctions",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(second.ok).toBe(true);
    expect(second.updated).toBe(1);
    expect(second.created).toBe(1);
    expect(second.deactivated).toBe(1);

    const grace = await prisma.sanctionsEntry.findFirst({ where: { name: "Grace Okoro" } });
    expect(grace?.isActive).toBe(false);

    const status = await getSanctionsRefreshStatus();
    expect(status?.status).toBe("ok");
    expect(status?.fetched).toBe(2);
    expect(status?.source).toBe("external:lists.example.test");
    expect(status?.finishedAt).toBeInstanceOf(Date);
  });

  it("records provider failures without wiping the active list", async () => {
    await prisma.sanctionsEntry.create({
      data: { name: "Existing Entry", listType: "sanction", aliases: "[]" },
    });

    const result = await refreshSanctionsList({
      sourceUrl: "https://lists.example.test/v1/sanctions",
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ error: "down" }, 503)) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
    expect(await prisma.sanctionsEntry.count({ where: { isActive: true } })).toBe(1);
    const status = await getSanctionsRefreshStatus();
    expect(status?.status).toBe("failed");
  });
});
