import { prisma } from "../lib/prisma.js";
import { audit } from "./audit.js";
import { alertSupers, AlertSeverity } from "../lib/alerting.js";

/**
 * Sanctions / PEP / adverse-media screening (CFT control — A16).
 *
 * Two providers, selected at runtime:
 *   - EXTERNAL: when `SANCTIONS_SCREENING_URL` is set, POST the subject to that
 *     endpoint (the endpoint is expected to hold the real watchlists).
 *   - LOCAL: otherwise, match against the platform-level `SanctionsEntry` table
 *     (an ops-managed list) using normalized fuzzy name matching.
 *
 * Every decision is recorded (ScreeningResult) and any non-clear hit alerts the
 * cooperative's supers. This is deliberately fail-safe at the money-out boundary:
 * a strong match ("matched") or a weak match ("review") blocks the payout.
 */

export type ScreeningStatus = "clear" | "review" | "matched" | "error";

export interface ScreeningMatch {
  name: string;
  score: number;
  listType: string;
  source?: string | null;
}

export interface ScreeningOutcome {
  status: ScreeningStatus;
  /** Best similarity score in [0,1]. */
  score: number;
  matches: ScreeningMatch[];
  provider: string;
}

export interface ScreeningContext {
  cooperativeId: string;
  subjectType: "member" | "nok" | "guarantor" | "payee" | "payout";
  subjectId?: string;
  subjectName: string;
}

function envFloat(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

const matchThreshold = () => envFloat("SANCTIONS_MATCH_THRESHOLD", 0.86);
const reviewThreshold = () => envFloat("SANCTIONS_REVIEW_THRESHOLD", 0.7);

/** Fail closed on a provider error unless explicitly told not to. */
function failClosed(): boolean {
  if (process.env.SANCTIONS_FAIL_CLOSED !== undefined) {
    return process.env.SANCTIONS_FAIL_CLOSED !== "0";
  }
  return process.env.NODE_ENV === "production";
}

/** Lowercase, strip diacritics, drop non-alphanumerics, collapse whitespace. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Similarity of two raw names in [0,1]: max of token-set Jaccard and edit ratio. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union ? inter / union : 0;
  const edit = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  return Math.max(jaccard, edit);
}

function parseAliases(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Match against the ops-managed local list. */
async function screenWithLocalList(name: string): Promise<ScreeningOutcome> {
  const entries = await prisma.sanctionsEntry.findMany({ where: { isActive: true } });
  const matches: ScreeningMatch[] = [];
  let best = 0;
  for (const entry of entries) {
    for (const candidate of [entry.name, ...parseAliases(entry.aliases)]) {
      const score = nameSimilarity(name, candidate);
      if (score >= reviewThreshold()) {
        matches.push({ name: candidate, score, listType: entry.listType, source: entry.source });
      }
      if (score > best) best = score;
    }
  }
  matches.sort((x, y) => y.score - x.score);
  return { status: "clear", score: best, matches: matches.slice(0, 5), provider: "local_list" };
}

/** Screen against an external provider when configured, else the local list. */
async function screenWithProvider(
  name: string,
  opts?: { country?: string },
): Promise<ScreeningOutcome> {
  const url = process.env.SANCTIONS_SCREENING_URL;
  if (!url) return screenWithLocalList(name);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.SANCTIONS_SCREENING_KEY
        ? { Authorization: `Bearer ${process.env.SANCTIONS_SCREENING_KEY}` }
        : {}),
    },
    body: JSON.stringify({ name, country: opts?.country }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`screening provider ${res.status}`);
  const body = (await res.json()) as { matches?: ScreeningMatch[]; score?: number };
  const matches = (body.matches ?? []).slice(0, 5);
  const best = body.score ?? matches.reduce((m, x) => Math.max(m, Number(x.score ?? 0)), 0);
  return { status: "clear", score: best, matches, provider: "external" };
}

/** Screen a name and return the outcome (no side effects). */
export async function screenName(
  name: string,
  opts?: { country?: string },
): Promise<ScreeningOutcome> {
  const normalized = normalizeName(name);
  if (!normalized) return { status: "clear", score: 0, matches: [], provider: "none" };

  let outcome: ScreeningOutcome;
  try {
    outcome = await screenWithProvider(name, opts);
  } catch (err) {
    console.error("[screening] provider error:", err);
    return { status: "error", score: 0, matches: [], provider: "external" };
  }

  const status: ScreeningStatus =
    outcome.score >= matchThreshold()
      ? "matched"
      : outcome.score >= reviewThreshold()
        ? "review"
        : "clear";
  return { ...outcome, status };
}

/** Whether a screening status must block money-out. */
export function isBlocking(status: ScreeningStatus): boolean {
  if (status === "matched" || status === "review") return true;
  if (status === "error") return failClosed();
  return false;
}

/**
 * Screen a subject, persist the result, and (for any non-clear hit) append an
 * audit entry and alert the cooperative's supers. Never throws — a screening
 * infrastructure failure must not crash onboarding or a payout by itself; the
 * caller decides how to react to the returned outcome.
 */
export async function screenAndRecord(
  name: string,
  ctx: ScreeningContext,
  opts?: { country?: string },
): Promise<ScreeningOutcome> {
  const outcome = await screenName(name, opts);
  try {
    await prisma.screeningResult.create({
      data: {
        cooperativeId: ctx.cooperativeId,
        subjectType: ctx.subjectType,
        subjectId: ctx.subjectId ?? null,
        subjectName: ctx.subjectName,
        status: outcome.status,
        score: outcome.score,
        provider: outcome.provider,
        matches: JSON.stringify(outcome.matches),
      },
    });
  } catch (err) {
    console.error("[screening] failed to record result:", err);
  }

  if (outcome.status !== "clear") {
    await audit({
      cooperativeId: ctx.cooperativeId,
      actorPhone: "system-screening",
      actorRole: "system",
      action: `screening.${outcome.status}`,
      targetType: ctx.subjectType,
      targetId: ctx.subjectId,
      detail: `${ctx.subjectType} "${ctx.subjectName}" screened ${outcome.status} (score ${outcome.score.toFixed(2)}, provider ${outcome.provider})`,
    });
    await alertSupers(
      ctx.cooperativeId,
      `⚠️ Screening *${outcome.status}* for ${ctx.subjectType} "${ctx.subjectName}" (score ${outcome.score.toFixed(2)}). ${outcome.status === "matched" ? "Money-out to this name is blocked." : "Please review and confirm."}`,
      AlertSeverity.CRITICAL,
    ).catch(() => {});
  }
  return outcome;
}
