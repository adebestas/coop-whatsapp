import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { sendDocument } from "../lib/messaging.js";
import { maskId } from "../lib/security.js";

export interface ReceiptData {
  reference: string;
  type: "deposit" | "withdrawal" | "loan_repayment" | "dividend" | "transfer";
  amount: number; // in kobo
  currency?: string;
  cooperativeName: string;
  memberName: string;
  memberPhone: string;
  date: Date;
  recipientAccount?: string | null;
  recipientBank?: string | null;
  recipientName?: string | null;
  status?: string;
}

/**
 * Render a branded transaction receipt PDF into a Buffer.
 * Compact, high-contrast, clean layout formatted for WhatsApp/Telegram delivery.
 */
export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // 500x700 receipt card layout
    const doc = new PDFDocument({ margin: 36, size: [420, 595] });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const currency = data.currency ?? "NGN";
    const dateFormatted = data.date.toLocaleString("en-GB", {
      timeZone: "Africa/Lagos",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    // Background card styling
    doc.rect(0, 0, doc.page.width, doc.page.height).fill("#f8fafc");

    // Header banner
    doc.rect(0, 0, doc.page.width, 54).fill("#0f172a");
    doc
      .fillColor("#ffffff")
      .fontSize(16)
      .font("Helvetica-Bold")
      .text(data.cooperativeName.toUpperCase(), 0, 18, { align: "center" });

    // Subtitle
    doc
      .fillColor("#0284c7")
      .fontSize(11)
      .font("Helvetica-Bold")
      .text("OFFICIAL TRANSACTION RECEIPT", 0, 70, { align: "center" });

    // Amount box
    doc
      .rect(36, 92, doc.page.width - 72, 60)
      .fill("#ffffff")
      .stroke("#e2e8f0");
    doc
      .fillColor("#0f172a")
      .fontSize(22)
      .font("Helvetica-Bold")
      .text(formatBalance(data.amount), 36, 108, { align: "center" });
    doc
      .fillColor("#16a34a")
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(`SUCCESSFUL (${currency})`, 0, 134, { align: "center" });

    // Details table
    let y = 175;
    const addRow = (label: string, value: string) => {
      doc.fillColor("#64748b").fontSize(10).font("Helvetica").text(label, 40, y);
      doc
        .fillColor("#0f172a")
        .fontSize(10)
        .font("Helvetica-Bold")
        .text(value, 180, y, { width: 200, align: "right" });
      y += 24;
      doc
        .moveTo(40, y - 6)
        .lineTo(doc.page.width - 40, y - 6)
        .strokeColor("#f1f5f9")
        .stroke();
    };

    const typeLabels: Record<string, string> = {
      deposit: "Thrift / Wallet Top-Up",
      withdrawal: "Member Withdrawal",
      loan_repayment: "Loan Installment Repay",
      dividend: "Dividend Distribution",
      transfer: "Peer-to-Peer Transfer",
    };

    addRow("Transaction Type", typeLabels[data.type] ?? data.type.toUpperCase());
    addRow("Reference", data.reference);
    addRow("Date & Time", dateFormatted);
    addRow("Member Name", data.memberName);
    addRow("Phone Number", maskId(data.memberPhone));

    if (data.recipientAccount && data.recipientBank) {
      addRow("Destination Bank", data.recipientBank);
      addRow("Account Number", `****${data.recipientAccount.slice(-4)}`);
    }
    if (data.recipientName) {
      addRow("Recipient Name", data.recipientName);
    }

    // Digital verification fingerprint
    const hash = createHash("sha256")
      .update(`${data.reference}:${data.amount}:${data.date.toISOString()}`)
      .digest("hex")
      .slice(0, 24)
      .toUpperCase();

    y += 15;
    doc
      .fillColor("#94a3b8")
      .fontSize(8)
      .font("Courier")
      .text(`Security Verification Hash: ${hash}`, 0, y, { align: "center" });

    // Footer
    doc
      .fillColor("#64748b")
      .fontSize(8)
      .font("Helvetica")
      .text(
        "Automated cooperative digital banking powered by WhatsApp & Telegram.",
        0,
        doc.page.height - 30,
        {
          align: "center",
        },
      );

    doc.end();
  });
}

/**
 * Fetch transaction metadata to build a receipt for a member.
 */
export async function getMemberReceiptData(
  memberId: string,
  reference?: string,
): Promise<ReceiptData | null> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { cooperative: true },
  });
  if (!member) return null;

  // If specific reference supplied, check contribution or payout or withdrawal
  if (reference) {
    const contribution = await prisma.contribution.findFirst({
      where: { memberId, reference, status: "confirmed" },
    });
    if (contribution) {
      return {
        reference: contribution.reference,
        type: "deposit",
        amount: contribution.amount,
        cooperativeName: member.cooperative.name,
        memberName: member.name,
        memberPhone: member.phone,
        date: contribution.paidAt ?? contribution.createdAt,
      };
    }

    const withdrawal = await prisma.withdrawalRequest.findFirst({
      where: { memberId, id: { endsWith: reference }, status: "paid" },
    });
    if (withdrawal) {
      return {
        reference: `WDR-${withdrawal.id.slice(-8)}`,
        type: "withdrawal",
        amount: withdrawal.amount,
        cooperativeName: member.cooperative.name,
        memberName: member.name,
        memberPhone: member.phone,
        date: withdrawal.finalizedAt ?? withdrawal.createdAt,
        recipientAccount: withdrawal.bankAccountNumber,
        recipientBank: withdrawal.bankName ?? withdrawal.bankCode,
      };
    }
  }

  // Otherwise, default to member's latest confirmed contribution or withdrawal
  const [latestContribution, latestWithdrawal] = await Promise.all([
    prisma.contribution.findFirst({
      where: { memberId, status: "confirmed" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.withdrawalRequest.findFirst({
      where: { memberId, status: "paid" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (!latestContribution && !latestWithdrawal) return null;

  if (
    latestContribution &&
    (!latestWithdrawal || latestContribution.createdAt >= latestWithdrawal.createdAt)
  ) {
    return {
      reference: latestContribution.reference,
      type: "deposit",
      amount: latestContribution.amount,
      cooperativeName: member.cooperative.name,
      memberName: member.name,
      memberPhone: member.phone,
      date: latestContribution.paidAt ?? latestContribution.createdAt,
    };
  }

  return {
    reference: `WDR-${latestWithdrawal!.id.slice(-8)}`,
    type: "withdrawal",
    amount: latestWithdrawal!.amount,
    cooperativeName: member.cooperative.name,
    memberName: member.name,
    memberPhone: member.phone,
    date: latestWithdrawal!.finalizedAt ?? latestWithdrawal!.createdAt,
    recipientAccount: latestWithdrawal!.bankAccountNumber,
    recipientBank: latestWithdrawal!.bankName ?? latestWithdrawal!.bankCode,
  };
}

/**
 * Deliver a digital transaction receipt directly to the member's chat.
 */
export async function sendReceipt(to: string, receipt: ReceiptData): Promise<boolean> {
  const pdfBuffer = await generateReceiptPdf(receipt);
  const filename = `receipt_${receipt.reference.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
  const caption = `🧾 *Transaction Receipt — ${receipt.reference}*\nAmount: ${formatBalance(receipt.amount)}\nStatus: Successful`;

  return sendDocument({
    to,
    filename,
    mimeType: "application/pdf",
    data: pdfBuffer,
    caption,
  });
}
