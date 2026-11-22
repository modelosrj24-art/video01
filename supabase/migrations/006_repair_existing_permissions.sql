-- ==============================================================================
-- AURUM PRIVÉ — RLS FUNCTION GRANT & SAFE REPAIR (006_repair_existing_permissions.sql)
-- Fixes "42501: permission denied for function is_admin" on pre-existing schemas
-- where RLS policies invoke public.is_admin() without EXECUTE grant to anon/authenticated.
-- ==============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'is_admin'
      AND p.pronargs = 0
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'auth_is_admin'
      AND p.pronargs = 0
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_is_admin() TO anon, authenticated';
  END IF;
END
$$;
