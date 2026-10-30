-- Row-Level Security for the coop shop and guarantor-substitution tables
-- (Stage 1: ENABLE, not FORCE). Each table carries a cooperativeId column, so
-- it uses the direct tenant policy.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ShopItem','ShopOrder','GuarantorSubstitution']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("cooperativeId" = app.current_coop_id()) WITH CHECK ("cooperativeId" = app.current_coop_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

COMMIT;
