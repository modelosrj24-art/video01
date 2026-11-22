-- ==============================================================================
-- AURUM PRIVÉ — SECURITY & SCHEMA VALIDATION SUITE (004_security_validation.sql)
-- Execute in Supabase SQL Editor after 001, 002, and 003 to audit RLS & constraints.
-- ==============================================================================

-- 1. Verify ALL public tables have Row Level Security enabled (must return 0 rows)
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND rowsecurity = FALSE;

-- 2. Verify every RLS-enabled table has at least 1 active policy (must return 0 rows)
SELECT t.tablename
FROM pg_tables t
LEFT JOIN pg_policies p ON p.schemaname = t.schemaname AND p.tablename = t.tablename
WHERE t.schemaname = 'public'
GROUP BY t.tablename
HAVING COUNT(p.policyname) = 0;

-- 3. Verify immutability triggers exist on financial_transactions and audit_logs
SELECT event_object_table, trigger_name, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND event_object_table IN ('financial_transactions', 'audit_logs')
ORDER BY event_object_table, trigger_name;

-- 4. Verify all foreign key indexes and unique booking conflict index exist
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
