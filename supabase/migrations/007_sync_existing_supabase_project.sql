-- ==============================================================================
-- AURUM PRIVÉ — SAFE IDEMPOTENT SYNC FOR EXISTING SUPABASE PROJECT
-- Target project: https://jyfpqcjpwdmzmpccdekw.supabase.co
-- Safe to run in Supabase SQL Editor when profiles, professionals, bookings,
-- payments, notifications, platform_settings, and audit_logs already exist.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Fix "42501: permission denied for function is_admin" if public.is_admin() exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_admin' AND p.pronargs = 0
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated';
  END IF;
END
$$;

-- 2. Ensure dedicated admin registry & helper functions exist
CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.auth_is_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_is_admin BOOLEAN;
  v_result BOOLEAN := FALSE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()) THEN
    RETURN TRUE;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_admin' AND p.pronargs = 0
  ) INTO v_has_is_admin;

  IF v_has_is_admin THEN
    EXECUTE 'SELECT COALESCE(public.is_admin(), FALSE)' INTO v_result;
    RETURN v_result;
  END IF;

  RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auth_is_admin() TO anon, authenticated;

DROP POLICY IF EXISTS admin_users_select_admin ON public.admin_users;
CREATE POLICY admin_users_select_admin ON public.admin_users
  FOR SELECT USING (public.auth_is_admin());

-- 3. Create missing operational tables safely (video_calls, balances, payouts, ledger)
CREATE TABLE IF NOT EXISTS public.video_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID UNIQUE,
  client_id UUID NOT NULL,
  professional_id UUID NOT NULL,
  room_name TEXT NOT NULL UNIQUE,
  call_status TEXT NOT NULL DEFAULT 'aguardando_pagamento',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.video_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS video_calls_admin_all ON public.video_calls;
CREATE POLICY video_calls_admin_all ON public.video_calls
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

DROP POLICY IF EXISTS video_calls_client_read ON public.video_calls;
CREATE POLICY video_calls_client_read ON public.video_calls
  FOR SELECT USING (
    client_id = auth.uid()
    OR professional_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.professionals pr
      WHERE pr.id = video_calls.professional_id AND pr.user_id = auth.uid()
    )
    OR public.auth_is_admin()
  );

CREATE TABLE IF NOT EXISTS public.professional_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id UUID NOT NULL UNIQUE,
  available_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (available_balance >= 0),
  pending_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (pending_balance >= 0),
  paid_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (paid_balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.professional_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS balances_scoped_read ON public.professional_balances;
CREATE POLICY balances_scoped_read ON public.professional_balances
  FOR SELECT USING (
    professional_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.professionals pr
      WHERE pr.id = professional_balances.professional_id AND pr.user_id = auth.uid()
    )
    OR public.auth_is_admin()
  );

CREATE TABLE IF NOT EXISTS public.payout_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id UUID NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payout_method TEXT NOT NULL,
  payout_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  admin_notes TEXT
);

ALTER TABLE public.payout_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payouts_admin_all ON public.payout_requests;
CREATE POLICY payouts_admin_all ON public.payout_requests
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

DROP POLICY IF EXISTS payouts_pro_read ON public.payout_requests;
CREATE POLICY payouts_pro_read ON public.payout_requests
  FOR SELECT USING (
    professional_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.professionals pr
      WHERE pr.id = payout_requests.professional_id AND pr.user_id = auth.uid()
    )
    OR public.auth_is_admin()
  );

-- 4. Multi-Gateway Payments Registry (Mercado Pago & PayPal)
CREATE TABLE IF NOT EXISTS public.payment_gateways (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  environment TEXT NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
  supported_methods TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  supported_currencies TEXT[] NOT NULL DEFAULT ARRAY['BRL']::TEXT[],
  split_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  compliance_verified BOOLEAN NOT NULL DEFAULT FALSE,
  compliance_notes TEXT NOT NULL DEFAULT '',
  encrypted_credentials TEXT,
  last_health_status TEXT NOT NULL DEFAULT 'unconfigured',
  last_health_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.payment_gateways (
  id, display_name, is_enabled, environment, supported_methods, supported_currencies, split_enabled, compliance_notes
)
VALUES
  (
    'mercadopago',
    'Mercado Pago',
    TRUE,
    'sandbox',
    ARRAY['pix', 'credit_card', 'debit_card'],
    ARRAY['BRL'],
    FALSE,
    'Validar termos de uso e elegibilidade de split antes de ativar em produção.'
  ),
  (
    'paypal',
    'PayPal',
    TRUE,
    'sandbox',
    ARRAY['paypal_wallet', 'card', 'international'],
    ARRAY['BRL', 'USD', 'EUR'],
    FALSE,
    'Validar aprovação de marketplace/payouts PayPal Commerce antes de ativar em produção.'
  )
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_payment_gateways_updated_at ON public.payment_gateways;
CREATE TRIGGER trg_payment_gateways_updated_at
  BEFORE UPDATE ON public.payment_gateways
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

ALTER TABLE public.payment_gateways ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_gateways_admin_all ON public.payment_gateways;
CREATE POLICY payment_gateways_admin_all ON public.payment_gateways
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

-- 5. Extend existing payments table cleanly for Multi-Gateway accounting
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'mercadopago',
  ADD COLUMN IF NOT EXISTS provider_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS professional_id UUID,
  ADD COLUMN IF NOT EXISTS gateway_environment TEXT NOT NULL DEFAULT 'sandbox',
  ADD COLUMN IF NOT EXISTS gateway_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS professional_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS net_received NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS external_capture_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS provider_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT,
  ADD COLUMN IF NOT EXISTS checkout_url TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_idempotency
  ON public.payments (provider, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_provider_status
  ON public.payments (provider, status, created_at DESC);

-- 6. Immutable Multi-Gateway Financial Ledger
CREATE TABLE IF NOT EXISTS public.financial_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID,
  professional_id UUID NOT NULL,
  client_id UUID,
  booking_id UUID,
  transaction_type TEXT NOT NULL,
  gross_amount NUMERIC(12,2) NOT NULL,
  gateway_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  platform_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  professional_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  currency CHAR(3) NOT NULL DEFAULT 'BRL',
  provider TEXT NOT NULL DEFAULT 'mercadopago',
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.financial_transactions
  ADD COLUMN IF NOT EXISTS gateway_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'mercadopago';

ALTER TABLE public.financial_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS financial_tx_scoped_read ON public.financial_transactions;
CREATE POLICY financial_tx_scoped_read ON public.financial_transactions
  FOR SELECT USING (
    professional_id = auth.uid()
    OR client_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.professionals pr
      WHERE pr.id = financial_transactions.professional_id AND pr.user_id = auth.uid()
    )
    OR public.auth_is_admin()
  );

-- 7. Webhook Idempotency & Event Log
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_id TEXT NOT NULL REFERENCES public.payment_gateways(id) ON DELETE RESTRICT,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  payment_id UUID,
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_message TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gateway_id, external_event_id)
);

ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_webhook_events_admin_read ON public.payment_webhook_events;
CREATE POLICY payment_webhook_events_admin_read ON public.payment_webhook_events
  FOR SELECT USING (public.auth_is_admin());

-- 8. Public-safe checkout gateway lookup RPC (never exposes encrypted_credentials)
CREATE OR REPLACE FUNCTION public.fn_get_enabled_checkout_gateways()
RETURNS TABLE (
  id TEXT,
  display_name TEXT,
  environment TEXT,
  supported_methods TEXT[],
  supported_currencies TEXT[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.id, g.display_name, g.environment, g.supported_methods, g.supported_currencies
  FROM public.payment_gateways g
  WHERE g.is_enabled = TRUE
  ORDER BY CASE g.id WHEN 'mercadopago' THEN 1 WHEN 'paypal' THEN 2 ELSE 99 END, g.display_name;
$$;

GRANT EXECUTE ON FUNCTION public.fn_get_enabled_checkout_gateways() TO anon, authenticated;
