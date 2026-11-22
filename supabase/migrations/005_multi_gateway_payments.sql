-- ==============================================================================
-- AURUM PRIVÉ — MULTI-GATEWAY PAYMENTS & LEDGER (005_multi_gateway_payments.sql)
-- Execute after 001, 002, 003 to enable Mercado Pago + PayPal simultaneously.
-- ==============================================================================

-- 1. Gateway configuration registry (encrypted credentials never exposed via RLS)
CREATE TABLE IF NOT EXISTS public.payment_gateways (
  id TEXT PRIMARY KEY, -- 'mercadopago', 'paypal', future: 'stripe', 'adyen'
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

CREATE TRIGGER trg_payment_gateways_updated_at
  BEFORE UPDATE ON public.payment_gateways
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

-- 2. Extend payments table with multi-gateway accounting, idempotency & fee breakdown
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS professional_id UUID REFERENCES public.professionals(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS gateway_environment TEXT NOT NULL DEFAULT 'sandbox' CHECK (gateway_environment IN ('sandbox', 'production')),
  ADD COLUMN IF NOT EXISTS gateway_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (gateway_fee >= 0),
  ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (platform_fee >= 0),
  ADD COLUMN IF NOT EXISTS professional_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (professional_amount >= 0),
  ADD COLUMN IF NOT EXISTS net_received NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (net_received >= 0),
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

CREATE INDEX IF NOT EXISTS idx_payments_professional
  ON public.payments (professional_id, created_at DESC)
  WHERE professional_id IS NOT NULL;

-- 3. Extend immutable financial_transactions ledger with gateway & fee attribution
ALTER TABLE public.financial_transactions
  ADD COLUMN IF NOT EXISTS gateway_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'mercadopago';

CREATE INDEX IF NOT EXISTS idx_financial_tx_provider
  ON public.financial_transactions (provider, created_at DESC);

-- 4. Webhook idempotency & audit log table
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_id TEXT NOT NULL REFERENCES public.payment_gateways(id) ON DELETE RESTRICT,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  payment_id UUID REFERENCES public.payments(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_message TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gateway_id, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_gateway_created
  ON public.payment_webhook_events (gateway_id, created_at DESC);

-- 5. Strict Row Level Security (credentials & webhook logs are strictly admin-only)
ALTER TABLE public.payment_gateways ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_gateways_admin_all ON public.payment_gateways;
CREATE POLICY payment_gateways_admin_all ON public.payment_gateways
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

DROP POLICY IF EXISTS payment_webhook_events_admin_read ON public.payment_webhook_events;
CREATE POLICY payment_webhook_events_admin_read ON public.payment_webhook_events
  FOR SELECT USING (public.auth_is_admin());

-- 6. Safe checkout RPC exposing ONLY active non-secret gateway capabilities
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

-- 7. Cross-gateway safe atomic payment confirmation & split ledger posting
CREATE OR REPLACE FUNCTION public.fn_process_confirmed_payment(
  p_payment_id UUID,
  p_provider_payment_id TEXT,
  p_provider TEXT DEFAULT NULL,
  p_gateway_fee NUMERIC DEFAULT 0.00,
  p_external_capture_id TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay RECORD;
  v_call_id UUID;
  v_platform_fee NUMERIC(12,2);
  v_pro_share NUMERIC(12,2);
  v_net_received NUMERIC(12,2);
  v_gateway_fee NUMERIC(12,2);
BEGIN
  SELECT py.*, b.professional_id AS booking_pro_id, b.is_instant, pr.commission_percentage
  INTO v_pay
  FROM public.payments py
  JOIN public.bookings b ON b.id = py.booking_id
  JOIN public.professionals pr ON pr.id = b.professional_id
  WHERE py.id = p_payment_id
  FOR UPDATE OF py;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pagamento não encontrado';
  END IF;

  IF p_provider IS NOT NULL AND v_pay.provider <> p_provider THEN
    RAISE EXCEPTION 'Isolamento de gateway violado: transação pertence ao gateway %, não a %', v_pay.provider, p_provider;
  END IF;

  IF v_pay.status = 'approved' THEN
    SELECT id INTO v_call_id FROM public.video_calls WHERE booking_id = v_pay.booking_id;
    RETURN v_call_id;
  END IF;

  v_gateway_fee := GREATEST(COALESCE(p_gateway_fee, 0.00), 0.00);
  v_platform_fee := ROUND((v_pay.amount * v_pay.commission_percentage) / 100.0, 2);
  v_pro_share := GREATEST(v_pay.amount - v_platform_fee, 0.00);
  v_net_received := GREATEST(v_pay.amount - v_gateway_fee, 0.00);

  UPDATE public.payments
  SET status = 'approved',
      professional_id = COALESCE(professional_id, v_pay.booking_pro_id),
      provider_payment_id = COALESCE(p_provider_payment_id, provider_payment_id),
      external_capture_id = COALESCE(p_external_capture_id, external_capture_id),
      gateway_fee = v_gateway_fee,
      platform_fee = v_platform_fee,
      professional_amount = v_pro_share,
      net_received = v_net_received,
      paid_at = NOW()
  WHERE id = p_payment_id;

  UPDATE public.bookings
  SET status = 'pagamento_confirmado'
  WHERE id = v_pay.booking_id;

  INSERT INTO public.video_calls (booking_id, client_id, professional_id, room_name, call_status, amount)
  VALUES (
    v_pay.booking_id,
    v_pay.client_id,
    v_pay.booking_pro_id,
    'aurum-' || replace(v_pay.booking_id::TEXT, '-', ''),
    CASE WHEN v_pay.is_instant THEN 'aguardando_profissional'::call_status_enum ELSE 'pagamento_confirmado'::call_status_enum END,
    v_pay.amount
  )
  ON CONFLICT (booking_id) DO UPDATE
  SET call_status = EXCLUDED.call_status
  RETURNING id INTO v_call_id;

  INSERT INTO public.financial_transactions (
    payment_id, professional_id, client_id, booking_id, transaction_type,
    gross_amount, gateway_fee, platform_fee, professional_amount, currency, provider
  ) VALUES (
    p_payment_id, v_pay.booking_pro_id, v_pay.client_id, v_pay.booking_id, 'session_credit',
    v_pay.amount, v_gateway_fee, v_platform_fee, v_pro_share, v_pay.currency, v_pay.provider
  );

  UPDATE public.professional_balances
  SET pending_balance = pending_balance + v_pro_share
  WHERE professional_id = v_pay.booking_pro_id;

  RETURN v_call_id;
END;
$$;
