import { prisma } from "../lib/prisma.js";
import ExcelJS from "exceljs";

export interface ImportRow {
  name: string;
  phone: string;
}

export interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  errors: string[];
  message: string;
}

const MAX_ROWS = 500;

function normalisePhone(raw: string): string {
  return raw.replace(/[^0-9+]/g, "").replace(/^\+/, "");
}

function parseCsv(buffer: Buffer): ImportRow[] {
  const text = buffer.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((l) => l.trim());
  const rows: ImportRow[] = [];
  let headerSkipped = false;
  for (const line of lines) {
    if (!headerSkipped && /^[a-z]/i.test(line) && /name/i.test(line) && /phone/i.test(line)) {
      headerSkipped = true;
      continue;
    }
    headerSkipped = true;
    const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
    if (parts.length < 2) continue;
    const [name, phone] = parts;
    if (name && phone) rows.push({ name, phone });
  }
  return rows;
}

async function parseExcel(buffer: Buffer): Promise<ImportRow[]> {
  const wb = new ExcelJS.Workbook();
  await (wb.xlsx as any).load(buffer);
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 1) return [];
  const rows: ImportRow[] = [];
  let startRow = 1;
  const firstRow = ws.getRow(1);
  const headerText = [firstRow.getCell(1).text, firstRow.getCell(2).text].join(" ").toLowerCase();
  if (/name/.test(headerText) && /phone/.test(headerText)) startRow = 2;
  for (let i = startRow; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const name = String(row.getCell(1).text ?? "").trim();
    const phone = String(row.getCell(2).text ?? "").trim();
    if (name && phone) rows.push({ name, phone });
  }
  return rows;
}

export async function bulkImportMembers(
  cooperativeId: string,
  buffer: Buffer,
  filename: string,
): Promise<ImportResult> {
  const ext = filename.toLowerCase().split(".").pop();
  let rows: ImportRow[];
  if (ext === "csv") {
    rows = parseCsv(buffer);
  } else if (ext === "xlsx" || ext === "xls") {
    rows = await parseExcel(buffer);
  } else {
    return { ok: false, imported: 0, skipped: 0, errors: ["Unsupported file type. Use .csv or .xlsx."], message: "Unsupported file type." };
  }

  if (rows.length === 0) {
    return { ok: false, imported: 0, skipped: 0, errors: ["No valid rows found. Ensure columns: Name, Phone."], message: "No rows found." };
  }
  if (rows.length > MAX_ROWS) {
    return { ok: false, imported: 0, skipped: 0, errors: [`Too many rows (max ${MAX_ROWS}). File has ${rows.length}.`], message: "Too many rows." };
  }

  const existingPhones = new Set(
    (
      await prisma.member.findMany({
        where: { cooperativeId, phone: { in: rows.map((r) => normalisePhone(r.phone)) } },
        select: { phone: true },
      })
    ).map((m) => m.phone),
  );

  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  if (!coop) return { ok: false, imported: 0, skipped: 0, errors: ["Cooperative not found"], message: "Cooperative not found." };

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const phone = normalisePhone(row.phone);
    if (!phone || phone.length < 7) {
      errors.push(`"${row.name}" — invalid phone "${row.phone}"`);
      continue;
    }
    if (existingPhones.has(phone)) {
      skipped += 1;
      continue;
    }
    try {
      const seq = coop.memberSeq + 1;
      await prisma.cooperative.update({ where: { id: cooperativeId }, data: { memberSeq: seq } });
      const code = `${coop.code}/${String(seq).padStart(3, "0")}`;

      const member = await prisma.member.create({
        data: {
          code,
          phone,
          name: row.name.trim().slice(0, 100),
          cooperativeId,
          status: "active",
          role: "member",
        },
      });

      await prisma.wallet.create({ data: { memberId: member.id } });

      existingPhones.add(phone);
      imported += 1;
    } catch (err: any) {
      errors.push(`"${row.name}" — ${err.message?.slice(0, 60) ?? "unknown error"}`);
    }
  }

  const msg = imported > 0
    ? `${imported} member(s) imported. ${skipped > 0 ? `${skipped} skipped (existing).` : ""} ${errors.length > 0 ? `${errors.length} errors.` : ""}`
    : `No members imported. ${skipped > 0 ? `${skipped} already exist.` : ""} ${errors.length > 0 ? errors[0] : ""}`;

  return { ok: imported > 0, imported, skipped, errors, message: msg };
}
