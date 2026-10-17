-- =============================================================================
-- RLS bootstrap resolver — mandate provider id (SECURITY DEFINER)
-- =============================================================================
-- Bypasses RLS so a mandate-status webhook can discover the owning tenant
-- before it can set the GUC. Owned by the table owner and marked SECURITY
-- DEFINER. Returns NULL when the provider mandate id is unknown OR ambiguous
-- (belongs to >1 cooperative), matching the fail-closed resolver family.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- Resolve the cooperative that owns a mandate by its provider mandate id.
CREATE OR REPLACE FUNCTION app.resolve_coop_by_mandate_provider_id(p_provider_mandate_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min("cooperativeId") ELSE NULL END
  FROM "Mandate"
  WHERE "providerMandateId" = p_provider_mandate_id;
$$;

-- Grant EXECUTE to the non-owner application role when it exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coop_app') THEN
    GRANT USAGE ON SCHEMA app TO coop_app;
    GRANT EXECUTE ON FUNCTION app.resolve_coop_by_mandate_provider_id(text) TO coop_app;
  END IF;
END $$;

COMMIT;
