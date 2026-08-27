import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";

const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";

export interface ComplianceExportResult {
  ok: boolean;
  message: string;
  files?: string[];
}

/**
 * Compliance exports (STR / PAYE) — generated as Excel + PDF, written to the
 * EXPORT_DIR so they can be downloaded from the dashboard via
 * `/api/export/<filename>`. Mirrors the members/transactions/pnl export flow.
 */

async function strData(cooperativeId: string): Promise<{ name: string; rows: string[][] }> {
  const strs = await prisma.sTR.findMany({
    where: { cooperativeId },
    include: { member: { select: { name: true, phone: true, code: true } } },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  const rows = [
    ["Filing Ref", "Date", "Member Code", "Member Name", "Phone", "Amount (kobo)", "Amount", "Reason", "Status"],
    ...strs.map((s) => [
      s.id,
      s.createdAt.toISOString(),
      s.member.code,
      s.member.name,
      s.member.phone,
      String(s.amount),
      formatBalance(s.amount),
      s.reason,
      s.status,
    ]),
  ];

  return { name: "STR", rows };
}

async function payeData(cooperativeId: string): Promise<{ name: string; rows: string[][] }> {
  const records = await prisma.pAYERecord.findMany({
    where: { cooperativeId },
    include: { member: { select: { name: true, code: true, phone: true } } },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    take: 2000,
  });

  const rows = [
    ["Record ID", "Member Code", "Member Name", "Period (MM/YYYY)", "Gross (kobo)", "Gross", "Tax (kobo)", "Tax", "Net (kobo)", "Net", "Status", "Remitted At"],
    ...records.map((r) => [
      r.id,
      r.member.code,
      r.member.name,
      `${String(r.month).padStart(2, "0")}/${r.year}`,
      String(r.grossAmount),
      formatBalance(r.grossAmount),
      String(r.taxAmount),
      formatBalance(r.taxAmount),
      String(r.netAmount),
      formatBalance(r.netAmount),
      r.status,
      r.remittedAt ? r.remittedAt.toISOString() : "",
    ]),
  ];

  return { name: "PAYE", rows };
}

export async function runComplianceExport(
  cooperativeId: string,
  kind: "str" | "paye",
): Promise<ComplianceExportResult> {
  if (kind !== "str" && kind !== "paye") {
    return { ok: false, message: "Unknown compliance export type. Use str or paye." };
  }

  await mkdir(EXPORT_DIR, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });

  const sheet = kind === "str" ? await strData(cooperativeId) : await payeData(cooperativeId);

  const base = `${kind}-compliance-${token.slice(0, 8)}`;
  const xlsxName = `${base}.xlsx`;
  const pdfName = `${base}.pdf`;

  await writeXlsx(join(EXPORT_DIR, xlsxName), sheet);
  await writePdf(join(EXPORT_DIR, pdfName), `${coop?.name ?? "Cooperative"} — ${kind.toUpperCase()} compliance export`, sheet);

  const links = [
    `📊 Excel: /api/export/${xlsxName}`,
    `📄 PDF: /api/export/${pdfName}`,
  ];

  await prisma.auditLog.create({
    data: {
      cooperativeId,
      actorId: "system",
      actorPhone: "dashboard",
      actorRole: "admin",
      action: "compliance.export",
      targetType: kind,
      detail: `${kind.toUpperCase()} compliance report exported`,
    },
  });

  return {
    ok: true,
    message: `📦 *${kind.toUpperCase()}* compliance report ready.\n${links.join("\n")}\n\n_Links stay valid while the files exist on the server._`,
    files: [xlsxName, pdfName],
  };
}

async function writeXlsx(path: string, sheet: { name: string; rows: string[][] }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet.name.slice(0, 31));
  ws.addRows(sheet.rows);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((col) => {
    col.width = Math.max(12, ...sheet.rows.map((r) => String(r[ws.columns.indexOf(col)] ?? "").length + 2));
  });
  await wb.xlsx.writeFile(path);
}

async function writePdf(path: string, title: string, sheet: { rows: string[][] }) {
  return new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: "A4" });
    const stream = doc.pipe(createWriteStream(path));
    doc.fontSize(14).text(title, { underline: true }).moveDown();
    doc.fontSize(8);
    for (const row of sheet.rows.slice(0, 400)) {
      doc.text(row.map((c) => String(c ?? "").replace(/\n/g, " ")).join("  |  "));
      if (doc.y > 780) {
        doc.addPage();
        doc.fontSize(8);
      }
    }
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

export type ComplianceKind = "str" | "paye";
