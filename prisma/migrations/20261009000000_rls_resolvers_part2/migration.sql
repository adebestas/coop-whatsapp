-- =============================================================================
-- RLS bootstrap resolvers (SECURITY DEFINER) — part 2
-- =============================================================================
-- These functions bypass RLS so the app can discover the tenant before it can
-- set the GUC. They are owned by the table owner and marked SECURITY DEFINER.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- List all cooperative IDs (for schedulers that need to iterate all coops).
CREATE OR REPLACE FUNCTION app.list_cooperative_ids()
RETURNS TABLE(id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id FROM "Cooperative" c ORDER BY c.id;
$$;

-- Resolve the cooperative that owns a virtual account number.
CREATE OR REPLACE FUNCTION app.resolve_coop_by_virtual_account(p_account text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min("cooperativeId") ELSE NULL END
  FROM "Member"
  WHERE "virtualAccountNumber" = p_account;
$$;

-- Resolve the cooperative that owns a payout reference (matches either the
-- provider reference or the deterministic idempotency key).
CREATE OR REPLACE FUNCTION app.resolve_coop_by_payout_reference(p_reference text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min("cooperativeId") ELSE NULL END
  FROM "Payout"
  WHERE reference = p_reference OR "idempotencyKey" = p_reference;
$$;

-- Resolve the cooperative by its join code.
CREATE OR REPLACE FUNCTION app.resolve_coop_by_code(p_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id FROM "Cooperative" WHERE code = p_code;
$$;

-- Grant EXECUTE to the non-owner application role when it exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coop_app') THEN
    GRANT USAGE ON SCHEMA app TO coop_app;
    GRANT EXECUTE ON FUNCTION app.list_cooperative_ids() TO coop_app;
    GRANT EXECUTE ON FUNCTION app.resolve_coop_by_virtual_account(text) TO coop_app;
    GRANT EXECUTE ON FUNCTION app.resolve_coop_by_payout_reference(text) TO coop_app;
    GRANT EXECUTE ON FUNCTION app.resolve_coop_by_code(text) TO coop_app;
  END IF;
END $$;

COMMIT;