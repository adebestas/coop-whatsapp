-- =============================================================================
-- RLS identity resolvers (SECURITY DEFINER)
-- =============================================================================
-- The RLS bootstrap problem: to set `app.current_cooperative_id` you must first
-- know the cooperative, but the queries that resolve it (member-by-phone, admin
-- login) read the RLS-protected "Member" table. With FORCE RLS on and no GUC
-- set, those reads return zero rows and nobody can be identified.
--
-- These functions are owned by the table owner and marked SECURITY DEFINER, so
-- they run with the owner's privileges and bypass RLS. They are deliberately
-- narrow: each returns ONLY a cooperative id (never member data), and returns
-- NULL when the identifier is unknown OR ambiguous (belongs to >1 cooperative),
-- matching the fail-closed behaviour of getMemberByPhone().
--
-- `SET search_path = public, pg_temp` pins the lookup path so a caller cannot
-- hijack resolution by changing search_path.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- Resolve the cooperative that owns a phone number.
-- NULL when unknown or when the phone is registered in more than one coop.
CREATE OR REPLACE FUNCTION app.resolve_coop_by_phone(p_phone text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min("cooperativeId") ELSE NULL END
  FROM "Member"
  WHERE phone = p_phone;
$$;

-- Resolve the cooperative that owns an alternate channel id (e.g. a linked
-- Telegram id stored on Member.altChannelId). Same fail-closed semantics.
CREATE OR REPLACE FUNCTION app.resolve_coop_by_alt_channel(p_channel text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min("cooperativeId") ELSE NULL END
  FROM "Member"
  WHERE "altChannelId" = p_channel;
$$;

-- Grant EXECUTE to the non-owner application role when it exists. The role is
-- created out-of-band (never with a password in version control); this keeps
-- the migration idempotent on databases where it has not been provisioned yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coop_app') THEN
    GRANT USAGE ON SCHEMA app TO coop_app;
    GRANT EXECUTE ON FUNCTION app.resolve_coop_by_phone(text) TO coop_app;
    GRANT EXECUTE ON FUNCTION app.resolve_coop_by_alt_channel(text) TO coop_app;
  END IF;
END $$;

COMMIT;
