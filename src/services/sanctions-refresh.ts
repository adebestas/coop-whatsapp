import { prisma } from "../lib/prisma.js";

/**
 * Sanctions / watchlist refresh (CFT control — A16).
 *
 * The local screening provider reads `SanctionsEntry` (ops-managed). This job
 * pulls a JSON feed from `SANCTIONS_LIST_URL` on a daily cadence and upserts
 * entries, so the local list cannot silently go stale. The refresh status is
 * persisted in `SanctionsListRefresh` and exposed to the platform console.
 */

export interface SanctionsListEntry {
  name: string;
  listType?: string;
  country?: string | null;
  aliases?: string[];
  source?: string;
}

export interface SanctionsRefreshResult {
  ok: boolean;
  source?: string;
  fetched?: number;
  created?: number;
  updated?: number;
  deactivated?: number;
  reason?: string;
  error?: string;
  finishedAt?: string;
}

export interface SanctionsRefreshDeps {
  fetchImpl?: typeof fetch;
  sourceUrl?: string;
  now?: Date;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function sourceLabel(url: string): string {
  try {
    return `external:${new URL(url).hostname}`;
  } catch {
    return "external";
  }
}

function parseEntries(payload: unknown): SanctionsListEntry[] {
  const raw = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { entries?: unknown }).entries)
      ? (payload as { entries: unknown[] }).entries
      : null;
  if (!raw) throw new Error("watchlist payload must be an array or { entries: [] }");

  const entries: SanctionsListEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const aliases = Array.isArray(row.aliases)
      ? row.aliases.filter((a): a is string => typeof a === "string")
      : undefined;
    entries.push({
      name,
      listType:
        typeof row.listType === "string" && row.listType.trim() ? row.listType.trim() : "sanction",
      country: typeof row.country === "string" ? row.country : null,
      aliases,
      source: typeof row.source === "string" ? row.source : undefined,
    });
  }
  return entries;
}

async function persistStatus(data: {
  source: string | null;
  status: string;
  fetched: number;
  created: number;
  updated: number;
  deactivated: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date;
}): Promise<void> {
  await prisma.sanctionsListRefresh.upsert({
    where: { id: "global" },
    create: { id: "global", ...data },
    update: data,
  });
}

export async function refreshSanctionsList(
  deps: SanctionsRefreshDeps = {},
): Promise<SanctionsRefreshResult> {
  const url = deps.sourceUrl ?? process.env.SANCTIONS_LIST_URL;
  const startedAt = deps.now ?? new Date();
  if (!url) {
    const reason = "SANCTIONS_LIST_URL is not configured";
    await persistStatus({
      source: null,
      status: "failed",
      fetched: 0,
      created: 0,
      updated: 0,
      deactivated: 0,
      error: reason,
      startedAt,
      finishedAt: new Date(),
    });
    return { ok: false, reason };
  }

  const source = sourceLabel(url);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`watchlist provider returned HTTP ${res.status}`);
    const entries = parseEntries(await res.json());

    let created = 0;
    let updated = 0;
    const seenNames: string[] = [];
    for (const entry of entries) {
      const listType = entry.listType ?? "sanction";
      seenNames.push(entry.name);
      const existing = await prisma.sanctionsEntry.findFirst({
        where: { name: entry.name, listType },
        select: { id: true },
      });
      const data = {
        name: entry.name,
        listType,
        country: entry.country ?? null,
        aliases: entry.aliases?.length ? JSON.stringify(entry.aliases) : "[]",
        source: entry.source ?? source,
        isActive: true,
      };
      if (existing) {
        await prisma.sanctionsEntry.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        await prisma.sanctionsEntry.create({ data });
        created++;
      }
    }

    let deactivated = 0;
    if (seenNames.length) {
      const stale = await prisma.sanctionsEntry.updateMany({
        where: { source, isActive: true, name: { notIn: seenNames } },
        data: { isActive: false },
      });
      deactivated = stale.count;
    }

    const finishedAt = new Date();
    await persistStatus({
      source,
      status: "ok",
      fetched: entries.length,
      created,
      updated,
      deactivated,
      error: null,
      startedAt,
      finishedAt,
    });
    return {
      ok: true,
      source,
      fetched: entries.length,
      created,
      updated,
      deactivated,
      finishedAt: finishedAt.toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await persistStatus({
      source,
      status: "failed",
      fetched: 0,
      created: 0,
      updated: 0,
      deactivated: 0,
      error: message,
      startedAt,
      finishedAt: new Date(),
    });
    return { ok: false, source, error: message };
  }
}

export async function getSanctionsRefreshStatus() {
  return prisma.sanctionsListRefresh.findUnique({ where: { id: "global" } });
}
