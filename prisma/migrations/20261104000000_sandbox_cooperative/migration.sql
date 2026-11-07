-- Developer-console sandbox tenant. Additive and safe: existing rows default
-- to false and no RLS policy depends on this column.
ALTER TABLE "Cooperative" ADD COLUMN "isSandbox" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Cooperative_isSandbox_idx" ON "Cooperative"("isSandbox");
