import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { prisma } from "../lib/prisma.js";
import { formatBalance, getMemberByPhone } from "./cooperative.js";
import { sendDocument, sendText } from "../lib/messaging.js";

export interface StatementTransaction {
  date: Date;
  description: string;
  type: "credit" | "debit";
  amount: number; // in kobo
  reference?: string;
}

export interface EStatementData {
  cooperativeName: string;
  memberName: string;
  memberCode: string;
  memberPhone: string;
  periodLabel: string;
  generatedAt: Date;
  openingBalance: number;
  closingBalance: number;
  totalCredit: number;
  totalDebit: number;
  transactions: StatementTransaction[];
}

/**
 * Generate an official bank-style PDF account statement.
 */
export async function generateEStatementPdf(data: EStatementData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // A4 size: 595 x 842
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Page background
    doc.rect(0, 0, doc.page.width, doc.page.height).fill("#ffffff");

    // Header bar
    doc.rect(0, 0, doc.page.width, 60).fill("#0f172a");
    doc
      .fillColor("#ffffff")
      .fontSize(18)
      .font("Helvetica-Bold")
      .text(data.cooperativeName.toUpperCase(), 40, 20);

    // Statement title
    doc
      .fillColor("#0284c7")
      .fontSize(12)
      .font("Helvetica-Bold")
      .text("OFFICIAL STATEMENT OF ACCOUNT", 40, 75);

    // Account Details Box
    doc
      .rect(40, 95, doc.page.width - 80, 75)
      .fill("#f8fafc")
      .stroke("#e2e8f0");

    doc.fillColor("#334155").font("Helvetica").fontSize(10);
    doc.text(`Account Name: ${data.memberName}`, 55, 110);
    doc.text(`Member Code: ${data.memberCode}`, 55, 126);
    doc.text(`Phone: ${data.memberPhone}`, 55, 142);

    doc.text(`Period: ${data.periodLabel}`, 340, 110);
    doc.text(
      `Generated: ${data.generatedAt.toLocaleDateString("en-NG", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })}`,
      340,
      126,
    );
    doc.text(`Currency: NGN (₦)`, 340, 142);

    // Balance Summary Box
    doc
      .rect(40, 180, doc.page.width - 80, 50)
      .fill("#f1f5f9")
      .stroke("#cbd5e1");

    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(10);
    doc.text(`Opening Balance: ${formatBalance(data.openingBalance)}`, 55, 190);
    doc.text(`Total Inflow (+): ${formatBalance(data.totalCredit)}`, 220, 190);
    doc.text(`Total Outflow (-): ${formatBalance(data.totalDebit)}`, 380, 190);

    doc.fillColor("#16a34a").font("Helvetica-Bold").fontSize(11);
    doc.text(`Closing Balance: ${formatBalance(data.closingBalance)}`, 55, 210);

    // Transactions Table Header
    let y = 245;
    doc.rect(40, y, doc.page.width - 80, 22).fill("#0f172a");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("DATE", 50, y + 6);
    doc.text("DESCRIPTION", 130, y + 6);
    doc.text("TYPE", 340, y + 6);
    doc.text("AMOUNT", 450, y + 6, { width: 90, align: "right" });

    y += 26;
    doc.font("Helvetica").fontSize(9);

    if (data.transactions.length === 0) {
      doc
        .fillColor("#64748b")
        .text("No transactions recorded for this period.", 50, y + 10, { align: "center" });
      y += 40;
    } else {
      data.transactions.forEach((tx, idx) => {
        // Simple page-break safeguard
        if (y > 750) {
          doc.addPage();
          y = 40;
        }

        const bg = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
        doc.rect(40, y, doc.page.width - 80, 20).fill(bg);

        const dateStr = tx.date.toLocaleDateString("en-NG", {
          month: "short",
          day: "2-digit",
        });

        doc.fillColor("#334155").text(dateStr, 50, y + 5);
        doc.text(tx.description.slice(0, 32), 130, y + 5);

        if (tx.type === "credit") {
          doc.fillColor("#16a34a").text("CREDIT", 340, y + 5);
          doc.text(`+${formatBalance(tx.amount)}`, 450, y + 5, { width: 90, align: "right" });
        } else {
          doc.fillColor("#dc2626").text("DEBIT", 340, y + 5);
          doc.text(`-${formatBalance(tx.amount)}`, 450, y + 5, { width: 90, align: "right" });
        }

        y += 20;
      });
    }

    // Tamper-evident verification hash
    const payload = `${data.memberCode}:${data.periodLabel}:${data.closingBalance}:${data.transactions.length}`;
    const hash = createHash("sha256").update(payload).digest("hex").slice(0, 16).toUpperCase();

    // Footer
    const footerY = doc.page.height - 50;
    doc
      .fontSize(8)
      .fillColor("#94a3b8")
      .font("Helvetica")
      .text(
        `Verification Hash: ${hash} | Automated certified document issued by ${data.cooperativeName}.`,
        40,
        footerY,
        { align: "center", width: doc.page.width - 80 },
      );

    doc.end();
  });
}

/**
 * Parses user input into a start and end Date range for a statement month.
 */
export function resolveStatementPeriod(
  periodInput?: string,
  now = new Date(),
): { start: Date; end: Date; label: string } {
  let targetYear = now.getFullYear();
  let targetMonth = now.getMonth(); // 0-11

  const trimmed = periodInput?.trim().toLowerCase();

  const monthNames = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];

  if (trimmed) {
    const monthIdx = monthNames.findIndex((m) => trimmed.startsWith(m));
    if (monthIdx !== -1) {
      targetMonth = monthIdx;
    } else if (trimmed === "last") {
      targetMonth = targetMonth === 0 ? 11 : targetMonth - 1;
      if (targetMonth === 11) targetYear -= 1;
    } else if (/^\d{4}-\d{2}$/.test(trimmed)) {
      const [y, m] = trimmed.split("-");
      targetYear = Number(y);
      targetMonth = Number(m) - 1;
    }
  }

  const start = new Date(targetYear, targetMonth, 1, 0, 0, 0, 0);
  const end = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);
  const label = start.toLocaleString("en-NG", { month: "long", year: "numeric" });

  return { start, end, label };
}

/**
 * Handle the WhatsApp / Telegram command `estatement [month]` to generate and send a PDF statement.
 */
export async function sendEStatement(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
    return;
  }

  const period = resolveStatementPeriod(args[0]);

  // Query member's transactions
  const [contributions, withdrawals, wallet] = await Promise.all([
    prisma.contribution.findMany({
      where: {
        memberId: member.id,
        status: "confirmed",
        paidAt: { gte: period.start, lte: period.end },
      },
      orderBy: { paidAt: "asc" },
    }),
    prisma.withdrawalRequest.findMany({
      where: {
        memberId: member.id,
        status: "paid",
        finalizedAt: { gte: period.start, lte: period.end },
      },
      orderBy: { finalizedAt: "asc" },
    }),
    prisma.wallet.findUnique({ where: { memberId: member.id } }),
  ]);

  const transactions: StatementTransaction[] = [];

  for (const c of contributions) {
    transactions.push({
      date: c.paidAt ?? c.createdAt,
      description: c.note || "Savings Contribution",
      type: "credit",
      amount: c.amount,
      reference: c.reference ?? undefined,
    });
  }

  for (const w of withdrawals) {
    transactions.push({
      date: w.finalizedAt ?? w.createdAt,
      description: "Wallet Withdrawal",
      type: "debit",
      amount: w.amount,
      reference: w.id.slice(-8),
    });
  }

  transactions.sort((a, b) => a.date.getTime() - b.date.getTime());

  const totalCredit = contributions.reduce((acc, c) => acc + c.amount, 0);
  const totalDebit = withdrawals.reduce((acc, w) => acc + w.amount, 0);
  const closingBalance = wallet?.balance ?? 0;
  const openingBalance = Math.max(0, closingBalance - totalCredit + totalDebit);

  const statementData: EStatementData = {
    cooperativeName: member.cooperative.name,
    memberName: member.name,
    memberCode: member.code,
    memberPhone: member.phone,
    periodLabel: period.label,
    generatedAt: new Date(),
    openingBalance,
    closingBalance,
    totalCredit,
    totalDebit,
    transactions,
  };

  const pdfBuffer = await generateEStatementPdf(statementData);
  const safeMonth = period.label.replace(/\s+/g, "_");
  const filename = `Statement_${safeMonth}_${member.code}.pdf`;

  await sendDocument({
    to: phone,
    data: pdfBuffer,
    mimeType: "application/pdf",
    filename,
    caption: `📄 Official Account Statement for *${period.label}* — ${member.cooperative.name}`,
  });
}
