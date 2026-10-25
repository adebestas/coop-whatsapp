-- Per-cooperative Nigeria compliance metadata (nullable). Set from the platform
-- console; mirrors the Cooperative fields in schema.prisma.
-- AlterTable
ALTER TABLE "Cooperative" ADD COLUMN "registrationNumber" TEXT,
ADD COLUMN "tin" TEXT,
ADD COLUMN "cvn" TEXT,
ADD COLUMN "scumlStatus" TEXT,
ADD COLUMN "dpoName" TEXT,
ADD COLUMN "dpoPhone" TEXT,
ADD COLUMN "dpoEmail" TEXT;
