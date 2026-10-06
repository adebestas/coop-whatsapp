import { prisma } from "../lib/prisma.js";
import { normalizePhone } from "../lib/phones.js";
import { getMemberByPhone } from "./cooperative.js";
import {
  parseDeductionFile,
  type ParsedRow,
  type ParseResult,
} from "../lib/deduction-parse/index.js";

export interface MappedRow extends ParsedRow {
  matched: boolean;
  memberId?: string;
  resolvedName?: string;
  reason?: string;
}

/**
 * Match parsed rows to members of a cooperative by code, phone, or exact name.
 * Unmatched rows are returned with a reason so the admin can fix the file.
 */
export async function mapRowsToMembers(
  cooperativeId: string,
  rows: ParsedRow[],
): Promise<MappedRow[]> {
  const members = await prisma.member.findMany({
    where: { cooperativeId, status: "active" },
    select: { id: true, code: true, name: true, phone: true, contactPhone: true },
  });
  const byCode = new Map(members.map((m) => [m.code.toUpperCase(), m]));
  const byPhone = new Map<string, (typeof members)[number]>();
  for (const m of members) {
    byPhone.set(m.phone, m);
    if (m.contactPhone) byPhone.set(m.contactPhone, m);
  }
  const byName = new Map(members.map((m) => [m.name.toLowerCase(), m]));

  return rows.map((row) => {
    let match = row.memberCode ? byCode.get(row.memberCode.toUpperCase()) : undefined;
    if (!match && row.phone) {
      const p = normalizePhone(row.phone);
      if (p) match = byPhone.get(p);
    }
    if (!match && row.memberName) match = byName.get(row.memberName.toLowerCase());
    if (!match) return { ...row, matched: false, reason: "No matching member" };
    return { ...row, matched: true, memberId: match.id, resolvedName: match.name };
  });
}

export interface IngestResult extends Omit<ParseResult, "rows"> {
  rows: MappedRow[];
  matchedCount: number;
  unmatchedCount: number;
}

/** Parse an uploaded file and match its rows to members. */
export async function ingestDeductionFile(
  cooperativeId: string,
  buffer: Buffer,
  filename: string,
): Promise<IngestResult> {
  const parsed = await parseDeductionFile(buffer, filename);
  const rows = await mapRowsToMembers(cooperativeId, parsed.rows);
  const matchedCount = rows.filter((r) => r.matched).length;
  return {
    ...parsed,
    rows,
    matchedCount,
    unmatchedCount: rows.length - matchedCount,
  };
}

/**
 * WhatsApp path: an admin sends a deduction file as a document or photo. Parse
 * it, match rows to members, and build a draft batch in one step.
 */
export async function handleDeductionUpload(
  phone: string,
  buffer: Buffer,
  filename: string,
): Promise<{ ok: boolean; message: string }> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    return {
      ok: false,
      message: "You need to join a cooperative first. Reply *join <code>* to get started.",
    };
  }
  if (member.role !== "admin" && member.role !== "superadmin") {
    return { ok: false, message: "Only a co-op admin can upload a deduction file." };
  }
  const ingested = await ingestDeductionFile(member.cooperativeId, buffer, filename);
  const matched = ingested.rows
    .filter((r) => r.matched && r.memberId)
    .map((r) => ({ memberId: r.memberId as string, amount: r.amount }));
  if (matched.length === 0) {
    return {
      ok: false,
      message: `I couldn't match any rows in *${filename}* to members.${
        ingested.warnings.length ? " " + ingested.warnings.join(" ") : ""
      }`,
    };
  }
  const { buildBatchFromRows } = await import("./deductions.js");
  const { uploadBufferToS3 } = await import("../lib/s3.js");
  const safeName = filename.replace(/[^\w.-]/g, "_");
  const key = `deductions/${member.cooperativeId}/${Date.now()}-${safeName}`;
  const uploaded = await uploadBufferToS3(buffer, key);
  const result = await buildBatchFromRows(phone, matched, `Uploaded ${filename}`, {
    key: uploaded ? key : undefined,
    name: filename,
  });
  if (!result.ok) return { ok: false, message: result.message };
  const warn =
    ingested.unmatchedCount > 0
      ? `\n⚠️ ${ingested.unmatchedCount} row(s) didn't match a member and were skipped.`
      : "";
  return { ok: true, message: result.message + warn };
}
