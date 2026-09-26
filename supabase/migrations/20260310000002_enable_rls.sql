-- Migration: Enable Row Level Security (RLS) across all SmartQueue tables
-- Protects Supabase PostgREST endpoints from unauthorized anon/public access.

-- 1. Enable RLS on all tables
ALTER TABLE IF EXISTS organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS services ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS risk_events ENABLE ROW LEVEL SECURITY;

-- 2. Define safe read policies for public directory info (organizations, services, counters)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'organizations' AND policyname = 'organizations_public_read'
  ) THEN
    CREATE POLICY organizations_public_read ON organizations FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'services' AND policyname = 'services_public_read'
  ) THEN
    CREATE POLICY services_public_read ON services FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'counters' AND policyname = 'counters_public_read'
  ) THEN
    CREATE POLICY counters_public_read ON counters FOR SELECT USING (true);
  END IF;
END $$;

-- 3. Sensitive tables (users, sessions, bookings, notifications, audit_log, risk_events)
-- By enabling RLS without public policies, all direct PostgREST anon access is DENIED.
-- The Express backend connects via direct connection string / service role which bypasses RLS safely.
