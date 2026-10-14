import { randomBytes } from "node:crypto";
import PDFDocument from "pdfkit";
import { prisma } from "../lib/prisma.js";
import { audit } from "./audit.js";

const BASE32_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Public, unguessable certificate reference code.
 * Format: CERT-<COOPCODE>-<10-char base32 suffix> (e.g. CERT-LAG01-7F3K9Q2X4M).
 */
export function generateReferenceCode(coopCode: string): string {
  const bytes = randomBytes(10);
  let suffix = "";
  for (const b of bytes) {
    suffix += BASE32_ALPHABET[b % BASE32_ALPHABET.length];
  }
  return `CERT-${coopCode}-${suffix}`;
}

export interface IssueCertificateParams {
  memberId: string;
  cooperativeId: string;
  score: number;
  totalQuestions: number;
  actorPhone: string;
}

/**
 * Create or refresh a member's certificate. One certificate per member
 * (memberId @unique); re-issue updates score/issuedAt and keeps the same
 * referenceCode. Writes an audit entry.
 */
export async function issueCertificate({
  memberId,
  cooperativeId,
  score,
  totalQuestions,
  actorPhone,
}: IssueCertificateParams) {
  const existing = await prisma.literacyCertificate.findUnique({ where: { memberId } });
  const referenceCode = existing?.referenceCode ?? generateReferenceCode("COOP");

  const cert = await prisma.literacyCertificate.upsert({
    where: { memberId },
    create: {
      cooperativeId,
      memberId,
      referenceCode,
      score,
      totalQuestions,
    },
    update: {
      score,
      totalQuestions,
      issuedAt: new Date(),
      revokedAt: null,
    },
  });

  await audit({
    cooperativeId,
    actorPhone,
    action: "literacy.certificate_issued",
    targetType: "LiteracyCertificate",
    targetId: cert.id,
    detail: `score ${score}/${totalQuestions} ref ${referenceCode}`,
  });

  return cert;
}

export interface CertificatePdfData {
  referenceCode: string;
  score: number;
  totalQuestions: number;
  issuedAt: Date;
}

export interface CertificatePdfMember {
  name: string;
  code: string;
}

export interface CertificatePdfCoop {
  displayName: string;
}

/**
 * Render a branded A4 certificate PDF into a Buffer (no file storage).
 * Deterministic rendering of the DB record.
 */
export async function renderCertificatePdf(
  cert: CertificatePdfData,
  member: CertificatePdfMember,
  coop: CertificatePdfCoop,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4", layout: "landscape" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const issued = cert.issuedAt.toISOString().slice(0, 10);

    doc.rect(0, 0, doc.page.width, doc.page.height).fill("#f5f7fa");
    doc.rect(0, 0, doc.page.width, 24).fill("#1a7f37");
    doc.rect(0, doc.page.height - 24, doc.page.width, 24).fill("#1a7f37");

    doc.fillColor("#1a7f37").fontSize(28).font("Helvetica-Bold").text(coop.displayName, { align: "center" });
    doc.moveDown(0.5);
    doc.fillColor("#111").fontSize(40).font("Helvetica-Bold").text("Certificate of Financial Literacy", { align: "center" });
    doc.moveDown(1.5);

    doc.fontSize(16).font("Helvetica").text("This certifies that", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(30).font("Helvetica-Bold").text(member.name, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(14).font("Helvetica").text(`Member code: ${member.code}`, { align: "center" });
    doc.moveDown(1.5);

    doc.fontSize(14).font("Helvetica").text(
      `has successfully completed the cooperative's financial literacy programme, scoring ${cert.score} out of ${cert.totalQuestions}.`,
      { align: "center", width: 600 },
    );
    doc.moveDown(2);

    doc.fontSize(12).font("Helvetica").text(`Issued: ${issued}`, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(12).font("Helvetica").text(`Reference: ${cert.referenceCode}`, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(10).font("Helvetica-Oblique").text(
      "Verify this certificate with your cooperative.",
      { align: "center" },
    );

    doc.end();
  });
}