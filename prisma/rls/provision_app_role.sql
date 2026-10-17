-- =============================================================================
-- Provision the non-owner application role for RLS enforcement (Stage 2)
-- =============================================================================
-- Run ONCE against the production database as the owner/superuser, BEFORE
-- pointing the app at it. After this:
--   DATABASE_URL       = postgresql://coop_app:<password>@...   (the app)
--   DATABASE_OWNER_URL = postgresql://<owner>:<password>@...   (migrations, backup)
--
-- The app then runs as a NON-OWNER, so the RLS policies actually bite. The owner
-- is used only for migrations and the system-level backup dump.
--
-- Replace the password with a strong secret from your vault. NEVER commit it.
-- =============================================================================

-- 1. Create the role (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coop_app') THEN
    CREATE ROLE coop_app LOGIN PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
  END IF;
END $$;

-- 2. Schema + object privileges.
GRANT USAGE ON SCHEMA public, app TO coop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO coop_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO coop_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO coop_app;

-- 3. Future objects created by later migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO coop_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO coop_app;
