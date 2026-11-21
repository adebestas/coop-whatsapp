-- Magic-link sign-in resolves a dashboard admin by the verified email address
-- they type, before any RLS context exists. Same fail-closed contract as the
-- phone resolver: NULL when unknown OR present in more than one cooperative.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.resolve_coop_by_email(p_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min("cooperativeId") ELSE NULL END
  FROM "Member"
  WHERE "email" IS NOT NULL
    AND lower("email") = lower(p_email)
    AND "emailVerifiedAt" IS NOT NULL;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coop_app') THEN
    GRANT USAGE ON SCHEMA app TO coop_app;
    GRANT EXECUTE ON FUNCTION app.resolve_coop_by_email(text) TO coop_app;
  END IF;
END
$$;

COMMIT;
