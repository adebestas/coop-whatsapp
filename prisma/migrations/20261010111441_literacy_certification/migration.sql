-- Financial literacy certification: quiz fields, config toggles, and certificate table.
-- Mirrors the MemberProgress, CooperativeConfig, and LiteracyCertificate models in schema.prisma.

ALTER TABLE "MemberProgress" ADD COLUMN "certificationOptIn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MemberProgress" ADD COLUMN "quizAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MemberProgress" ADD COLUMN "quizScore" INTEGER;
ALTER TABLE "MemberProgress" ADD COLUMN "quizPassedAt" TIMESTAMP(3);

ALTER TABLE "CooperativeConfig" ADD COLUMN "literacyCertificationEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CooperativeConfig" ADD COLUMN "literacyQuizPassMark" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "CooperativeConfig" ADD COLUMN "literacyQuizQuestionCount" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "CooperativeConfig" ADD COLUMN "certifiedLoanBoost" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "LiteracyCertificate" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "referenceCode" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "totalQuestions" INTEGER NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiteracyCertificate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LiteracyCertificate_memberId_key" ON "LiteracyCertificate"("memberId");
CREATE UNIQUE INDEX "LiteracyCertificate_referenceCode_key" ON "LiteracyCertificate"("referenceCode");
CREATE INDEX "LiteracyCertificate_cooperativeId_idx" ON "LiteracyCertificate"("cooperativeId");
ALTER TABLE "LiteracyCertificate" ADD CONSTRAINT "LiteracyCertificate_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiteracyCertificate" ADD CONSTRAINT "LiteracyCertificate_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;