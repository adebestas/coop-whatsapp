-- Row-Level Security for provisioning tables (Stage 1: ENABLE, not FORCE).
-- ProvisionRun carries a cooperativeId column -> direct policy.
-- ProvisionEntry is a child of ProvisionRun -> parent-resolver policy.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ProvisionRun']
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
      ('ProvisionEntry', 'runId', 'ProvisionRun')
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
