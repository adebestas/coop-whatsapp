/**
 * Employer deduction-schedule ingestion.
 *
 * Accepts the file an employer sends (Excel, CSV, PDF, or a photo) and turns it
 * into a list of {member, amount} rows. Amounts are parsed as NAIRA and stored
 * as KOBO. Parsing is best-effort: unparseable rows are reported as warnings
 * rather than silently dropped.
 */

import { toKobo } from "../money.js";

export interface ParsedRow {
  memberCode?: string;
  memberName?: string;
  phone?: string;
  amount: number; // kobo
  raw: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  warnings: string[];
  format: "csv" | "excel" | "pdf" | "ocr";
}

const HEADER_HINTS = {
  code: /code|staff|employee|member\s*id|file\s*no|id\b/i,
  name: /name/i,
  phone: /phone|mobile|msisdn|contact/i,
  amount: /amount|deduction|savings|contribution|salary|remit|net/i,
};

/** Parse a naira amount string ("₦5,000.50", "5000") into kobo. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[₦,\s]/g, "").replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return toKobo(n);
}

/** Split a text line into columns, preferring tabs / runs of spaces. */
function splitLine(line: string): string[] {
  if (/\t| {2,}/.test(line)) {
    return line
      .split(/\t| {2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return line.trim().split(/\s+/);
}

/** Split one CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Turn a grid of cells into deduction rows. Detects a header row by looking for
 * column-name hints; otherwise falls back to a positional heuristic.
 */
export function parseMatrix(matrix: string[][]): { rows: ParsedRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedRow[] = [];
  if (matrix.length === 0) return { rows, warnings: ["The file is empty."] };

  const first = matrix[0].map((c) => String(c ?? ""));
  const headerIdx: Record<string, number> = {};
  first.forEach((cell, i) => {
    if (headerIdx.code === undefined && HEADER_HINTS.code.test(cell)) headerIdx.code = i;
    if (headerIdx.name === undefined && HEADER_HINTS.name.test(cell)) headerIdx.name = i;
    if (headerIdx.phone === undefined && HEADER_HINTS.phone.test(cell)) headerIdx.phone = i;
    if (headerIdx.amount === undefined && HEADER_HINTS.amount.test(cell)) headerIdx.amount = i;
  });
  const hasHeader = Object.keys(headerIdx).length >= 2;
  const dataRows = hasHeader ? matrix.slice(1) : matrix;

  for (const r of dataRows) {
    const cells = r.map((c) => String(c ?? "").trim());
    if (cells.every((c) => !c)) continue;

    let code: string | undefined;
    let name: string | undefined;
    let phone: string | undefined;
    let amountCell: string | undefined;

    if (hasHeader) {
      code = headerIdx.code !== undefined ? cells[headerIdx.code] : undefined;
      name = headerIdx.name !== undefined ? cells[headerIdx.name] : undefined;
      phone = headerIdx.phone !== undefined ? cells[headerIdx.phone] : undefined;
      amountCell = headerIdx.amount !== undefined ? cells[headerIdx.amount] : undefined;
    } else {
      const numeric = cells.filter((c) => parseAmount(c) !== null);
      amountCell = numeric[numeric.length - 1];
      const nonNumeric = cells.filter((c) => parseAmount(c) === null);
      code = nonNumeric[0];
      name = nonNumeric[1];
    }

    const amount = amountCell ? parseAmount(amountCell) : null;
    if (amount === null) {
      warnings.push(`Skipped a row with no readable amount: ${cells.join(" | ")}`);
      continue;
    }
    rows.push({
      memberCode: code || undefined,
      memberName: name || undefined,
      phone: phone || undefined,
      amount,
      raw: cells.join(" | "),
    });
  }

  if (rows.length === 0) warnings.push("No deduction rows could be read from the file.");
  return { rows, warnings };
}

export function parseCsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const res = parseMatrix(lines.map(splitCsvLine));
  return { ...res, format: "csv" };
}

export async function parseExcel(buffer: Buffer): Promise<ParseResult> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const matrix: string[][] = [];
  if (ws) {
    ws.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value as { text?: string } | null;
        cells.push(v === null || v === undefined ? "" : String(v.text ?? v));
      });
      matrix.push(cells);
    });
  }
  const res = parseMatrix(matrix);
  return { ...res, format: "excel" };
}

export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const data = await pdfParse(buffer);
  const lines = data.text.split(/\r?\n/).filter((l) => l.trim());
  const res = parseMatrix(lines.map(splitLine));
  return { ...res, format: "pdf" };
}

export async function parseImage(buffer: Buffer): Promise<ParseResult> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(buffer);
    const lines = data.text.split(/\r?\n/).filter((l) => l.trim());
    const res = parseMatrix(lines.map(splitLine));
    return { ...res, format: "ocr" };
  } finally {
    await worker.terminate();
  }
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"];

/** Dispatch to the right parser based on the file extension. */
export async function parseDeductionFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (ext === "csv") return parseCsv(buffer.toString("utf8"));
  if (ext === "xlsx" || ext === "xls") return parseExcel(buffer);
  if (ext === "pdf") return parsePdf(buffer);
  if (IMAGE_EXTS.includes(ext)) return parseImage(buffer);
  throw new Error(`Unsupported file type: .${ext}`);
}
