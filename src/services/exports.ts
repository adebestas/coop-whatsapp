import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { prisma } from "../lib/prisma.js";
import { computePnl } from "./ledger.js";
import { uploadToS3 } from "../lib/s3.js";
import { audit } from "./audit.js";
import { quorumMet, resolveMeeting } from "./meetings.js";

export const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";

export type ExportKind = "members" | "transactions" | "pnl";

/** A named set of string rows — the shared unit for every export writer. */
export interface ReportSheet {
  name: string;
  rows: string[][];
}

export interface ExportResult {
  ok: boolean;
  message: string;
  files?: string[];
}

/**
 * Super-admin exports: member details and financial transactions as Excel +
 * PDF. Files are downloadable from the dashboard and emailed to the
 * requesting super admin when SMTP is configured.
 */
export async function runExport(
  requester: { id: string; name: string; email: string | null; cooperativeId: string },
  kind: ExportKind,
  appBaseUrl: string,
): Promise<ExportResult> {
  if (!["members", "transactions", "pnl"].includes(kind)) {
    return {
      ok: false,
      message: "Unknown export type. Use *export members*, *export transactions* or *export pnl*.",
    };
  }

  await mkdir(EXPORT_DIR, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const coop = await prisma.cooperative.findUnique({ where: { id: requester.cooperativeId } });

  const sheets =
    kind === "members"
      ? await membersData(requester.cooperativeId)
      : kind === "transactions"
        ? await transactionsData(requester.cooperativeId)
        : await pnlData(requester.cooperativeId);

  const base = `${kind}-${token.slice(0, 8)}`;
  const xlsxName = `${base}.xlsx`;
  const pdfName = `${base}.pdf`;

  await writeXlsx(join(EXPORT_DIR, xlsxName), sheets);
  await writePdf(
    join(EXPORT_DIR, pdfName),
    `${coop?.name ?? "Cooperative"} — ${kind.toUpperCase()} export`,
    sheets,
  );

  // Upload to S3 for persistent storage (if configured)
  const s3Keys: string[] = [];
  for (const fileName of [xlsxName, pdfName]) {
    const localPath = join(EXPORT_DIR, fileName);
    const s3Key = `exports/${requester.cooperativeId}/${fileName}`;
    const uploaded = await uploadToS3(localPath, s3Key);
    if (uploaded) {
      s3Keys.push(s3Key);
    }
  }

  const links = [
    `📊 Excel: ${appBaseUrl}/api/export/${xlsxName}`,
    `📄 PDF: ${appBaseUrl}/api/export/${pdfName}`,
  ];

  // Email the files to the requesting super admin when possible.
  let emailNote = "";
  if (requester.email && process.env.SMTP_HOST) {
    const sent = await emailFiles(
      requester.email,
      `[${coop?.name ?? "Coop"}] ${kind} export`,
      `Attached are the requested "${kind}" exports.\n\n${links.join("\n")}`,
      [join(EXPORT_DIR, xlsxName), join(EXPORT_DIR, pdfName)],
    );
    emailNote = sent
      ? `\n\n📧 A copy was emailed to ${requester.email}.`
      : `\n\n⚠️ Email delivery failed — use the download links.`;
  } else if (!requester.email) {
    emailNote = `\n\n_Tip: add an email (\`email you@x.com\`) to get exports mailed to you._`;
  }

  await audit({
    cooperativeId: requester.cooperativeId,
    actorId: requester.id,
    actorPhone: "export",
    actorRole: "superadmin",
    action: "data.export",
    targetType: kind,
    detail: `${kind} exported by member ${requester.id}`,
  });

  const storage = s3Keys.length === 2 ? "S3" : s3Keys.length === 1 ? "S3 (partial)" : "local";
  return {
    ok: true,
    message: `📦 *${kind}* export ready (stored on ${storage}):\n${links.join("\n")}${emailNote}\n\n_Links stay valid while the files exist on the server. S3 copies are permanent._`,
    files: [join(EXPORT_DIR, xlsxName), join(EXPORT_DIR, pdfName)],
  };
}

/**
 * Export a meeting's minutes (attendance, motions, tallies, resolutions) to
 * Excel + PDF, reusing the shared export pipeline, and return download links.
 * Mirrors `runExport` but is scoped to a single meeting.
 */
export async function exportMeetingMinutes(
  requester: { id: string; name: string; email: string | null; cooperativeId: string },
  meetingId: string,
  appBaseUrl: string,
): Promise<ExportResult> {
  const meeting = await resolveMeeting(requester.cooperativeId, meetingId);
  if (!meeting) return { ok: false, message: "Meeting not found. Check the id and try again." };

  await mkdir(EXPORT_DIR, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const coop = await prisma.cooperative.findUnique({ where: { id: requester.cooperativeId } });
  const sheet = await minutesData(meeting);

  const base = `${requester.cooperativeId}-minutes-${token.slice(0, 8)}`;
  const xlsxName = `${base}.xlsx`;
  const pdfName = `${base}.pdf`;

  await writeXlsx(join(EXPORT_DIR, xlsxName), sheet);
  await writePdf(
    join(EXPORT_DIR, pdfName),
    `${coop?.name ?? "Cooperative"} — Minutes: ${meeting.title}`,
    sheet,
  );

  const s3Keys: string[] = [];
  for (const fileName of [xlsxName, pdfName]) {
    const s3Key = `exports/${requester.cooperativeId}/${fileName}`;
    if (await uploadToS3(join(EXPORT_DIR, fileName), s3Key)) s3Keys.push(s3Key);
  }

  await audit({
    cooperativeId: requester.cooperativeId,
    actorId: requester.id,
    actorPhone: "export",
    actorRole: "admin",
    action: "meeting.minutes_export",
    targetType: "meeting",
    targetId: meeting.id,
    detail: `minutes exported for "${meeting.title}"`,
  });

  const links = [
    `📊 Excel: ${appBaseUrl}/api/export/${xlsxName}`,
    `📄 PDF: ${appBaseUrl}/api/export/${pdfName}`,
  ];
  const storage = s3Keys.length === 2 ? "S3" : s3Keys.length === 1 ? "S3 (partial)" : "local";
  return {
    ok: true,
    message: `📜 *Minutes export* ready (stored on ${storage}):\n${links.join("\n")}`,
    files: [join(EXPORT_DIR, xlsxName), join(EXPORT_DIR, pdfName)],
  };
}

// ---------- data builders ----------

async function minutesData(meeting: {
  id: string;
  cooperativeId: string;
  title: string;
  type: string;
  status: string;
  quorumPercent: number;
  createdAt: Date;
}): Promise<{ name: string; rows: string[][] }> {
  const [attendance, motions, quorum] = await Promise.all([
    prisma.meetingAttendance.findMany({
      where: { meetingId: meeting.id, present: true },
      include: {
        member: { select: { name: true, code: true } },
        proxyForMember: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.motion.findMany({
      where: { meetingId: meeting.id },
      include: { votes: { select: { choice: true } } },
      orderBy: { createdAt: "asc" },
    }),
    quorumMet(meeting.cooperativeId, meeting.id),
  ]);

  const carried = motions.filter((m) => m.status === "passed");

  const rows: string[][] = [
    ["Minutes", meeting.title],
    ["Type", meeting.type.toUpperCase()],
    ["Status", meeting.status],
    ["Called", meeting.createdAt.toISOString().slice(0, 10)],
    [
      "Quorum",
      `${quorum.present}/${quorum.eligible} present — ${quorum.met ? "met" : "NOT met"} (required ${quorum.required}, ${meeting.quorumPercent}%)`,
    ],
    [],
    ["Attendance"],
    ["Name", "Code", "Basis"],
    ...attendance.map((row) => [
      row.member.name,
      row.member.code,
      row.proxyForMember ? `proxy of ${row.proxyForMember.name}` : "in person",
    ]),
    [],
    ["Motions"],
    ["Title", "Kind", "Status", "Yes", "No", "Abstain"],
    ...motions.map((m) => [
      m.title,
      m.kind,
      m.status,
      String(m.votes.filter((v) => v.choice === "yes").length),
      String(m.votes.filter((v) => v.choice === "no").length),
      String(m.votes.filter((v) => v.choice === "abstain").length),
    ]),
    [],
    ["Resolutions (carried)"],
    ...carried.map((m) => [m.title]),
  ];
  return { name: "Minutes", rows };
}

async function membersData(cooperativeId: string): Promise<{ name: string; rows: string[][] }> {
  const members = await prisma.member.findMany({
    where: { cooperativeId },
    include: { wallet: true, unit: true },
    orderBy: { createdAt: "asc" },
  });
  const rows = [
    [
      "Code",
      "Name",
      "Chat ID",
      "Contact Phone",
      "Email",
      "DOB",
      "Next of Kin",
      "NOK Phone",
      "Role",
      "Status",
      "Unit",
      "Wallet Balance",
      "Total Saved",
      "Joined",
    ],
    ...members.map((m) => [
      m.code,
      m.name,
      m.phone,
      m.contactPhone ?? "",
      m.email ?? "",
      m.dateOfBirth ? m.dateOfBirth.toISOString().slice(0, 10) : "",
      m.nextOfKinName ?? "",
      m.nextOfKinPhone ?? "",
      m.role,
      m.status,
      m.unit?.name ?? "",
      String(m.wallet?.balance ?? 0),
      String(m.wallet?.totalSaved ?? 0),
      m.createdAt.toISOString().slice(0, 10),
    ]),
  ];
  return { name: "Members", rows };
}

async function transactionsData(
  cooperativeId: string,
): Promise<{ name: string; rows: string[][] }> {
  const [contributions, loans, withdrawals, payouts, externals, ledger] = await Promise.all([
    prisma.contribution.findMany({
      where: { cooperativeId },
      include: { member: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.loan.findMany({
      where: { cooperativeId },
      include: { member: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.withdrawalRequest.findMany({
      where: { cooperativeId },
      include: { member: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.payout.findMany({
      where: { cooperativeId },
      include: { member: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.externalPayment.findMany({ where: { cooperativeId }, orderBy: { createdAt: "asc" } }),
    prisma.ledgerEntry.findMany({ where: { cooperativeId }, orderBy: { createdAt: "asc" } }),
  ]);

  interface Row {
    date: Date;
    type: string;
    direction: string;
    who: string;
    amount: number;
    status: string;
  }
  const all: Row[] = [
    ...contributions.map((c) => ({
      date: c.createdAt,
      type: `contribution (${c.type})`,
      direction: "IN",
      who: c.member.name,
      amount: c.amount,
      status: c.status,
    })),
    ...loans.map((l) => ({
      date: l.disbursedAt ?? l.createdAt,
      type: "loan disbursement",
      direction: "OUT",
      who: l.member.name,
      amount: l.disbursementAmount ?? l.amount,
      status: l.status,
    })),
    ...withdrawals.map((w) => ({
      date: w.finalizedAt ?? w.createdAt,
      type: "withdrawal",
      direction: "OUT",
      who: w.member.name,
      amount: w.amount,
      status: w.status,
    })),
    ...payouts.map((p) => ({
      date: p.createdAt,
      type: `payout (${p.note ?? "general"})`,
      direction: "OUT",
      who: p.member.name,
      amount: p.amount,
      status: p.status,
    })),
    ...externals.map((e) => ({
      date: e.updatedAt,
      type: "pay-anyone",
      direction: "OUT",
      who: e.beneficiaryName,
      amount: e.amount,
      status: e.status,
    })),
    ...ledger.map((l) => ({
      date: l.createdAt,
      type: `P&L ${l.type} (${l.category})`,
      direction: l.type === "income" ? "—" : "—",
      who: l.note ?? "",
      amount: l.amount,
      status: "-",
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  return {
    name: "Transactions",
    rows: [
      ["Date", "Type", "Direction", "Member/Beneficiary", "Amount", "Status"],
      ...all.map((r) => [
        r.date.toISOString(),
        r.type,
        r.direction,
        r.who,
        String(r.amount),
        r.status,
      ]),
    ],
  };
}

async function pnlData(cooperativeId: string): Promise<{ name: string; rows: string[][] }> {
  const pnl = await computePnl(cooperativeId);
  const entries = await prisma.ledgerEntry.findMany({
    where: { cooperativeId },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  const summary = [["Category", "Type", "Amount"]];
  for (const [cat, amt] of Object.entries(pnl.incomeByCategory))
    summary.push([cat, "income", String(amt)]);
  for (const [cat, amt] of Object.entries(pnl.expenseByCategory))
    summary.push([cat, "expense", String(amt)]);
  summary.push(["TOTAL INCOME", "", String(pnl.totalIncome)]);
  summary.push(["TOTAL EXPENSE", "", String(pnl.totalExpense)]);
  summary.push(["NET PROFIT", "", String(pnl.netProfit)]);

  return {
    name: "Profit & Loss",
    rows: [
      ...summary,
      [],
      ["Date", "Type", "Category", "Amount", "Note", "Ref"],
      ...entries.map((e) => [
        e.createdAt.toISOString(),
        e.type,
        e.category,
        String(e.amount),
        e.note ?? "",
        e.reference ?? "",
      ]),
    ],
  };
}

// ---------- file writers ----------

/** Append one named sheet (bold header row, auto width) to a workbook. */
function addWorkbookSheet(wb: ExcelJS.Workbook, sheet: ReportSheet) {
  const ws = wb.addWorksheet(sheet.name.slice(0, 31));
  ws.addRows(sheet.rows);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((col) => {
    col.width = Math.max(
      12,
      ...sheet.rows.map((r) => String(r[ws.columns.indexOf(col)] ?? "").length + 2),
    );
  });
}

/** Write one sheet to an .xlsx workbook (existing single-sheet export shape). */
export async function writeXlsx(path: string, sheet: ReportSheet) {
  const wb = new ExcelJS.Workbook();
  addWorkbookSheet(wb, sheet);
  await wb.xlsx.writeFile(path);
}

/** Write many sheets into a single .xlsx workbook, one tab per sheet. */
export async function writeXlsxMany(path: string, sheets: ReportSheet[]) {
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) addWorkbookSheet(wb, sheet);
  await wb.xlsx.writeFile(path);
}

/** Stream one sheet's rows under a title at 8pt (existing export shape). */
function writePdfRows(doc: PDFKit.PDFDocument, rows: string[][]) {
  doc.fontSize(8);
  for (const row of rows.slice(0, 400)) {
    doc.text(row.map((c) => String(c ?? "").replace(/\n/g, " ")).join("  |  "));
    if (doc.y > 780) {
      doc.addPage();
      doc.fontSize(8);
    }
  }
}

/** Write one sheet to a PDF under the given title (existing export shape). */
export async function writePdf(path: string, title: string, sheet: ReportSheet) {
  return new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: "A4" });
    const stream = doc.pipe(createWriteStream(path));
    doc.fontSize(14).text(title, { underline: true }).moveDown();
    writePdfRows(doc, sheet.rows);
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

/** Write many sheets to a PDF, each on a new page under its own heading. */
export async function writePdfMany(path: string, title: string, sheets: ReportSheet[]) {
  return new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: "A4" });
    const stream = doc.pipe(createWriteStream(path));
    doc.fontSize(14).text(title, { underline: true }).moveDown();
    let first = true;
    for (const sheet of sheets) {
      if (!first) doc.addPage();
      first = false;
      doc.fontSize(11).text(sheet.name, { underline: true }).moveDown(0.5);
      writePdfRows(doc, sheet.rows);
    }
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

/** Quote a CSV cell when it contains a comma, quote or newline. */
function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Write many sheets to one .csv, each preceded by a `# <name>` comment line. */
export async function writeCsv(path: string, sheets: ReportSheet[]) {
  const lines: string[] = [];
  for (const sheet of sheets) {
    lines.push(`# ${sheet.name}`);
    for (const row of sheet.rows) lines.push(row.map(csvCell).join(","));
    lines.push("");
  }
  await writeFile(path, lines.join("\n"), "utf8");
}

/**
 * Build the three report artifacts (xlsx + pdf + csv) for a named set of sheets
 * at `basePath` (extension-less). Returns the written paths.
 */
export async function buildReportFiles(
  basePath: string,
  title: string,
  sheets: ReportSheet[],
): Promise<{ xlsx: string; pdf: string; csv: string }> {
  const xlsx = `${basePath}.xlsx`;
  const pdf = `${basePath}.pdf`;
  const csv = `${basePath}.csv`;
  await writeXlsxMany(xlsx, sheets);
  await writePdfMany(pdf, title, sheets);
  await writeCsv(csv, sheets);
  return { xlsx, pdf, csv };
}

async function emailFiles(
  to: string,
  subject: string,
  body: string,
  attachments: string[],
): Promise<boolean> {
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to,
      subject,
      text: body,
      attachments: attachments.map((path) => ({ path })),
    });
    return true;
  } catch (err) {
    console.error("[exports] email failed:", err);
    return false;
  }
}
