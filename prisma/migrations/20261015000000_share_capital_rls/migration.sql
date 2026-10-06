-- Row-Level Security for share-capital tables (Stage 1: ENABLE, not FORCE).
-- Both tables carry a cooperativeId column, so they use the direct policy.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ShareAccount','ShareTransaction']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("cooperativeId" = app.current_coop_id()) WITH CHECK ("cooperativeId" = app.current_coop_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

COMMIT;
