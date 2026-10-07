-- =============================================================================
-- RLS bootstrap resolver — mandate-debit reference (SECURITY DEFINER)
-- =============================================================================
-- Bypasses RLS so a webhook can discover the owning tenant before it can set
-- the GUC. Owned by the table owner and marked SECURITY DEFINER.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- Resolve the cooperative that owns a mandate-debit reference.
CREATE OR REPLACE FUNCTION app.resolve_coop_by_mandate_debit_ref(p_reference text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min("cooperativeId") ELSE NULL END
  FROM "MandateDebit"
  WHERE "providerRef" = p_reference;
$$;

-- Grant EXECUTE to the non-owner application role when it exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coop_app') THEN
    GRANT USAGE ON SCHEMA app TO coop_app;
    GRANT EXECUTE ON FUNCTION app.resolve_coop_by_mandate_debit_ref(text) TO coop_app;
  END IF;
END $$;

COMMIT;
