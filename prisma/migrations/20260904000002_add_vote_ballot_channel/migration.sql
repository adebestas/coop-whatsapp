-- AlterTable: track which channel a member vote was cast on (one vote per voter enforced by unique index).
ALTER TABLE "VoteBallot" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'whatsapp';
