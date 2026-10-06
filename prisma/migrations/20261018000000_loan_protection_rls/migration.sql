-- Row-Level Security for the loan-protection table (Stage 1: ENABLE, not FORCE).
-- LoanProtection carries a cooperativeId column, so it uses the direct policy.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['LoanProtection']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("cooperativeId" = app.current_coop_id()) WITH CHECK ("cooperativeId" = app.current_coop_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

COMMIT;
