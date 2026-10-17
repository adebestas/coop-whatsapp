-- OPS-3: distinguish STR (suspicious-pattern) from CTR (large-transaction threshold).

ALTER TABLE "STR" ADD COLUMN "reportType" TEXT NOT NULL DEFAULT 'STR';

