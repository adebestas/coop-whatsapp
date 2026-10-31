-- Row-Level Security for commodity credit tables (Stage 1: ENABLE, not FORCE).
-- CommodityScheme, CommoditySubscription and DeductionShortfall carry a
-- cooperativeId column, so they use the direct policy. CommoditySchemeItem is
-- reached through its tenant parent CommodityScheme, so it uses the
-- parent-resolver policy.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CommodityScheme','CommoditySubscription','DeductionShortfall']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("cooperativeId" = app.current_coop_id()) WITH CHECK ("cooperativeId" = app.current_coop_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('CommoditySchemeItem', 'schemeId', 'CommodityScheme')
    ) AS v(child, fk, parent)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id())) WITH CHECK (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id()))',
      r.child || '_tenant_isolation', r.child,
      r.parent, r.child, r.fk,
      r.parent, r.child, r.fk
    );
  END LOOP;
END $$;

COMMIT;
