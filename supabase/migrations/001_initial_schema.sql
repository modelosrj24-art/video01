-- ==============================================================================
-- AURUM PRIVÉ — SUPABASE POSTGRESQL SCHEMA (001_initial_schema.sql)
-- ==============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enums
CREATE TYPE user_role_enum AS ENUM ('admin', 'professional', 'client');
CREATE TYPE account_status_enum AS ENUM ('active', 'pending', 'suspended', 'blocked');
CREATE TYPE availability_status_enum AS ENUM ('online', 'offline', 'busy');
CREATE TYPE booking_status_enum AS ENUM (
  'aguardando_pagamento',
  'pagamento_confirmado',
  'em_andamento',
  'finalizada',
  'cancelada',
  'expirou'
);
CREATE TYPE call_status_enum AS ENUM (
  'aguardando_pagamento',
  'pagamento_confirmado',
  'aguardando_profissional',
  'aguardando_cliente',
  'iniciando',
  'em_andamento',
  'finalizada',
  'cancelada',
  'recusada',
  'expirou',
  'falha'
);
CREATE TYPE payment_status_enum AS ENUM ('pending', 'approved', 'rejected', 'refunded', 'cancelled');
CREATE TYPE transaction_type_enum AS ENUM ('session_credit', 'refund_debit', 'payout_debit', 'adjustment');
CREATE TYPE payout_status_enum AS ENUM ('pending', 'approved', 'rejected', 'paid');
CREATE TYPE discount_type_enum AS ENUM ('percentage', 'fixed_cents');

-- ==============================================================================
-- 1. PROFILES & DEDICATED ADMIN REGISTRY
-- ==============================================================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL CHECK (char_length(trim(full_name)) >= 2),
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  avatar_url TEXT,
  user_role user_role_enum NOT NULL DEFAULT 'client',
  status account_status_enum NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Separate privilege table: users cannot promote themselves by updating profiles.user_role
CREATE TABLE public.admin_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==============================================================================
-- 2. PROFESSIONALS, CLIENTS & PRIVATE CRM NOTES
-- ==============================================================================
CREATE TABLE public.professionals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  professional_name TEXT NOT NULL CHECK (char_length(trim(professional_name)) >= 2),
  slug TEXT NOT NULL UNIQUE,
  bio TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  languages TEXT[] NOT NULL DEFAULT ARRAY['Português'],
  profile_image TEXT,
  gallery TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  price_per_session NUMERIC(12,2) NOT NULL CHECK (price_per_session >= 0),
  price_per_minute NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (price_per_minute >= 0),
  session_duration INTEGER NOT NULL DEFAULT 30 CHECK (session_duration BETWEEN 5 AND 240),
  commission_percentage NUMERIC(5,2) NOT NULL DEFAULT 30.00 CHECK (commission_percentage BETWEEN 0 AND 100),
  availability_status availability_status_enum NOT NULL DEFAULT 'offline',
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  instant_call_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.professional_client_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id UUID NOT NULL REFERENCES public.professionals(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (professional_id, client_id)
);

-- ==============================================================================
-- 3. PROFESSIONAL AVAILABILITY & SCHEDULE BLOCKS
-- ==============================================================================
CREATE TABLE public.professional_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id UUID NOT NULL REFERENCES public.professionals(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (end_time > start_time),
  UNIQUE (professional_id, day_of_week, start_time)
);

CREATE TABLE public.professional_availability_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id UUID NOT NULL REFERENCES public.professionals(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL DEFAULT 'Indisponibilidade temporária',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

-- ==============================================================================
-- 4. BOOKINGS & VIDEO CALLS
-- ==============================================================================
CREATE TABLE public.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  professional_id UUID NOT NULL REFERENCES public.professionals(id) ON DELETE RESTRICT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 240),
  billing_mode TEXT NOT NULL DEFAULT 'session' CHECK (billing_mode IN ('session', 'per_minute')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  coupon_code TEXT,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
  status booking_status_enum NOT NULL DEFAULT 'aguardando_pagamento',
  cancellation_reason TEXT,
  is_instant BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_bookings_no_exact_conflict
  ON public.bookings (professional_id, scheduled_at)
  WHERE status NOT IN ('cancelada', 'expirou');

CREATE TABLE public.video_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES public.bookings(id) ON DELETE RESTRICT,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  professional_id UUID NOT NULL REFERENCES public.professionals(id) ON DELETE RESTRICT,
  room_name TEXT NOT NULL UNIQUE,
  call_status call_status_enum NOT NULL DEFAULT 'aguardando_pagamento',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==============================================================================
-- 5. PAYMENTS, IMMUTABLE LEDGER, BALANCES & PAYOUTS
-- ==============================================================================
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'mercadopago',
  provider_payment_id TEXT UNIQUE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'BRL',
  status payment_status_enum NOT NULL DEFAULT 'pending',
  payment_method TEXT NOT NULL DEFAULT 'pix',
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.financial_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID REFERENCES public.payments(id) ON DELETE RESTRICT,
  professional_id UUID NOT NULL REFERENCES public.professionals(id) ON DELETE RESTRICT,
  client_id UUID REFERENCES public.clients(id) ON DELETE RESTRICT,
  booking_id UUID REFERENCES public.bookings(id) ON DELETE RESTRICT,
  transaction_type transaction_type_enum NOT NULL,
  gross_amount NUMERIC(12,2) NOT NULL,
  platform_fee NUMERIC(12,2) NOT NULL,
  professional_amount NUMERIC(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.professional_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id UUID NOT NULL UNIQUE REFERENCES public.professionals(id) ON DELETE CASCADE,
  available_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (available_balance >= 0),
  pending_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (pending_balance >= 0),
  paid_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (paid_balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.payout_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id UUID NOT NULL REFERENCES public.professionals(id) ON DELETE RESTRICT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payout_method TEXT NOT NULL,
  payout_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  status payout_status_enum NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  admin_notes TEXT
);

-- ==============================================================================
-- 6. REVIEWS, FAVORITES, COUPONS, NOTIFICATIONS, SETTINGS & AUDIT LOGS
-- ==============================================================================
CREATE TABLE public.reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  professional_id UUID NOT NULL REFERENCES public.professionals(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL UNIQUE REFERENCES public.bookings(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'flagged')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  professional_id UUID NOT NULL REFERENCES public.professionals(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, professional_id)
);

CREATE TABLE public.coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  discount_type discount_type_enum NOT NULL,
  discount_value NUMERIC(12,2) NOT NULL CHECK (discount_value > 0),
  usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  expiration_date TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.platform_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key TEXT NOT NULL UNIQUE,
  setting_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==============================================================================
-- 7. PERFORMANCE INDEXES
-- ==============================================================================
CREATE INDEX idx_profiles_role_status ON public.profiles (user_role, status);
CREATE INDEX idx_professionals_approved_status ON public.professionals (is_approved, availability_status);
CREATE INDEX idx_professionals_category ON public.professionals (category) WHERE is_approved = TRUE;
CREATE INDEX idx_availability_pro_day ON public.professional_availability (professional_id, day_of_week);
CREATE INDEX idx_blocks_pro_window ON public.professional_availability_blocks (professional_id, starts_at, ends_at);
CREATE INDEX idx_bookings_client ON public.bookings (client_id, scheduled_at DESC);
CREATE INDEX idx_bookings_professional ON public.bookings (professional_id, scheduled_at DESC);
CREATE INDEX idx_video_calls_status ON public.video_calls (call_status);
CREATE INDEX idx_video_calls_participants ON public.video_calls (client_id, professional_id);
CREATE INDEX idx_payments_booking ON public.payments (booking_id, status);
CREATE INDEX idx_financial_tx_prof ON public.financial_transactions (professional_id, created_at DESC);
CREATE INDEX idx_payout_requests_status ON public.payout_requests (status, requested_at DESC);
CREATE INDEX idx_reviews_pro_status ON public.reviews (professional_id, status, created_at DESC);
CREATE INDEX idx_notifications_user_unread ON public.notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_audit_logs_created ON public.audit_logs (created_at DESC);
