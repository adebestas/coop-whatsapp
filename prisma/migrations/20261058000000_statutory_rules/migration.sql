-- AlterTable
ALTER TABLE "CooperativeConfig" ADD COLUMN "reserveFundPercent" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN "educationFundPercent" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN "dividendCapPercent" INTEGER NOT NULL DEFAULT 5;

INSERT INTO "PlatformPolicy" ("key", "value", "min", "max", "locked", "updatedAt")
VALUES ('reserveFundPercent', '25', 25, NULL, true, now())
ON CONFLICT ("key") DO NOTHING;
