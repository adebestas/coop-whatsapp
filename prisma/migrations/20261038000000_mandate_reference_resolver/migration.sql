-- =============================================================================
-- RLS bootstrap resolver — mandate provider reference (SECURITY DEFINER)
-- =============================================================================
-- Bypasses RLS so a Paystack authorization webhook can discover the owning
-- tenant before it can set the GUC. Paystack's `direct_debit.authorization.created`
-- event carries only `data.customer.email`, from which we derive our
-- deterministic `providerReference` (`<reference>@coop.local`). Owned by the
-- table owner and marked SECURITY DEFINER. Returns NULL when the reference is
-- unknown OR ambiguous (belongs to >1 cooperative), matching the fail-closed
-- resolver family.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- Resolve the cooperative that owns a mandate by our provider reference.
CREATE OR REPLACE FUNCTION app.resolve_coop_by_mandate_reference(p_provider_reference text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min("cooperativeId") ELSE NULL END
  FROM "Mandate"
  WHERE "providerReference" = p_provider_reference;
$$;

-- Grant EXECUTE to the non-owner application role when it exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coop_app') THEN
    GRANT USAGE ON SCHEMA app TO coop_app;
    GRANT EXECUTE ON FUNCTION app.resolve_coop_by_mandate_reference(text) TO coop_app;
  END IF;
END $$;

COMMIT;
