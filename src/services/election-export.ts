import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { prisma } from "../lib/prisma.js";

const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";

export interface ElectionExportResult {
  ok: boolean;
  message: string;
  file?: string;
}

/**
 * Final election-result PDF export (transparency). Only available once the
 * election is closed/tallied — a live election is refused. The PDF is written
 * to EXPORT_DIR so it can be downloaded via `/api/export/<filename>`.
 */
export async function exportElectionPdf(
  cooperativeId: string,
  voteId: string,
): Promise<ElectionExportResult> {
  const vote = await prisma.vote.findUnique({
    where: { id: voteId },
    include: {
      cooperative: { select: { name: true } },
      candidates: {
        include: {
          member: { select: { name: true, code: true } },
          ballots: { select: { id: true } },
        },
      },
    },
  });
  if (!vote || vote.cooperativeId !== cooperativeId) {
    return { ok: false, message: "Election not found." };
  }
  if (vote.status !== "closed") {
    return { ok: false, message: "Election results PDF is only available after the election is closed." };
  }

  const unitName = vote.unitId
    ? (await prisma.unit.findUnique({ where: { id: vote.unitId }, select: { name: true } }))?.name
    : undefined;

  const voters: Record<string, string> = {};
  const channelCount: Record<string, number> = {};
  const ballots = await prisma.voteBallot.findMany({
    where: { voteId: vote.id },
    include: { voter: { select: { name: true } } },
  });
  for (const b of ballots) {
    voters[b.voterId] ??= b.voter.name;
    channelCount[b.channel || "whatsapp"] = (channelCount[b.channel || "whatsapp"] ?? 0) + 1;
  }

  const totalVotes = vote.candidates.reduce((s, c) => s + c.ballots.length, 0);
  const tally = vote.candidates
    .map((c) => ({
      name: c.member.name,
      code: c.member.code,
      votes: c.ballots.length,
    }))
    .sort((a, b) => b.votes - a.votes);
  const winner = tally[0];

  await mkdir(EXPORT_DIR, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const pdfName = `election-results-${token.slice(0, 8)}.pdf`;
  const path = join(EXPORT_DIR, pdfName);

  await writeElectionPdf(path, vote, unitName, tally, totalVotes, winner, voters, channelCount);
  return {
    ok: true,
    message: `📄 Election results PDF ready.\nDownload: /api/export/${pdfName}`,
    file: pdfName,
  };
}

interface PdfVote {
  title: string;
  position: string | null;
  kind: string;
  electionType: string;
  status: string;
  closedAt: Date | null;
  quorumRequired: number;
  cooperative: { name: string };
  winnerId: string | null;
}

function writeElectionPdf(
  path: string,
  vote: PdfVote,
  unitName: string | undefined,
  tally: { name: string; code: string; votes: number }[],
  totalVotes: number,
  winner: { name: string; code: string; votes: number } | undefined,
  voters: Record<string, string>,
  channelCount: Record<string, number>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const stream = doc.pipe(createWriteStream(path));

    doc.fontSize(18).text("Election Results", { align: "center" }).moveDown(0.2);
    doc.fontSize(12).text(vote.cooperative.name, { align: "center" }).moveDown(1);
    doc.fontSize(11).text(`Election: ${vote.title}`);
    if (vote.position) doc.text(`Position: ${vote.position}`);
    if (unitName) doc.text(`Scope: ${unitName}`);
    doc.text(`Type: ${vote.electionType} (${vote.kind.toUpperCase()})`);
    doc.text(`Status: ${vote.status}`);
    doc.text(`Closed: ${vote.closedAt ? vote.closedAt.toISOString() : "—"}`);
    doc.moveDown(1);

    doc.fontSize(13).text("Results", { underline: true }).moveDown(0.5);
    doc.fontSize(10);
    for (const c of tally) {
      const pct = totalVotes > 0 ? `${((c.votes / totalVotes) * 100).toFixed(1)}%` : "0%";
      doc.text(`${c.name}  (${c.code || "—"}): ${c.votes} vote(s)  (${pct})`);
    }
    doc.moveDown(1);
    doc.fontSize(10).text(`Total votes cast: ${totalVotes}`);
    doc.text("Voting channel(s):");
    doc.text(formatChannels(channelCount));
    doc.text(`Quorum required: ${vote.quorumRequired}% of active members`);

    if (vote.winnerId && winner) {
      doc.moveDown(1).fontSize(12).text(`Winner: ${winner.name}  (${winner.code || "—"})`, { underline: true });
    }

    doc.moveDown(1).fontSize(10).text("Voters", { underline: true });
    const voterNames = Object.values(voters);
    doc.text(voterNames.length ? voterNames.join(", ") : "No ballots recorded.");

    doc.moveDown(2).fontSize(8).text(`Generated: ${new Date().toISOString()}`, { align: "center" });
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

function formatChannels(channelCount: Record<string, number>): string {
  const order = ["whatsapp", "telegram", "web"];
  const label: Record<string, string> = { whatsapp: "WhatsApp", telegram: "Telegram", web: "Web" };
  const parts = order
    .filter((k) => (channelCount[k] ?? 0) > 0)
    .map((k) => `${label[k]} (${channelCount[k]})`);
  if (parts.length === 0) return "No votes recorded.";
  return parts.join(", ");
}
