-- =============================================================================
-- Cooperative selection for phones registered in more than one cooperative
-- =============================================================================
-- A phone can belong to several cooperatives. The bare-phone resolver returns
-- NULL for those (fail-closed), which previously locked the member out entirely.
-- This adds a resolver that lists every cooperative for a phone, plus a place to
-- remember the member's choice.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- SECURITY DEFINER: bypasses RLS so the app can discover the tenant(s) before a
-- context exists. Returns only id/name/code — never member data.
CREATE OR REPLACE FUNCTION app.resolve_coops_by_phone(p_phone text)
RETURNS TABLE(id text, name text, code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT m."cooperativeId" AS id, c.name AS name, c.code AS code
  FROM "Member" m
  JOIN "Cooperative" c ON c.id = m."cooperativeId"
  WHERE m.phone = p_phone
  ORDER BY c.name;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coop_app') THEN
    GRANT EXECUTE ON FUNCTION app.resolve_coops_by_phone(text) TO coop_app;
  END IF;
END $$;

-- Remember the member's chosen cooperative (Session is global, not RLS-scoped).
ALTER TABLE "Session" ADD COLUMN "selectedCoopId" TEXT;

COMMIT;
