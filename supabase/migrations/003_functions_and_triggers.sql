-- ==============================================================================
-- AURUM PRIVÉ — TRIGGERS, FUNCTIONS & ATOMIC WORKFLOWS (003_functions_and_triggers.sql)
-- ==============================================================================

-- 1. Automatic updated_at maintenance
CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
CREATE TRIGGER trg_professionals_updated_at BEFORE UPDATE ON public.professionals FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
CREATE TRIGGER trg_clients_updated_at BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
CREATE TRIGGER trg_balances_updated_at BEFORE UPDATE ON public.professional_balances FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
CREATE TRIGGER trg_settings_updated_at BEFORE UPDATE ON public.platform_settings FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

-- 2. Auto-provision profile + client row on Supabase Auth signup (forces client role)
CREATE OR REPLACE FUNCTION public.fn_handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
BEGIN
  v_full_name := COALESCE(NULLIF(trim(NEW.raw_user_meta_data ->> 'full_name'), ''), split_part(NEW.email, '@', 1));

  INSERT INTO public.profiles (id, full_name, email, phone, user_role, status)
  VALUES (NEW.id, v_full_name, LOWER(NEW.email), NEW.raw_user_meta_data ->> 'phone', 'client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.fn_handle_new_auth_user();

-- 3. Initialize professional balance row automatically
CREATE OR REPLACE FUNCTION public.fn_init_professional_balance()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.professional_balances (professional_id)
  VALUES (NEW.id)
  ON CONFLICT (professional_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_init_professional_balance
  AFTER INSERT ON public.professionals
  FOR EACH ROW EXECUTE FUNCTION public.fn_init_professional_balance();

-- 4. Immutability guard for financial_transactions & audit_logs
CREATE OR REPLACE FUNCTION public.fn_prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Registros financeiros e de auditoria são imutáveis.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_financial_tx_immutable
  BEFORE UPDATE OR DELETE ON public.financial_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();

CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();

-- 5. Booking overlap & approval validation trigger
CREATE OR REPLACE FUNCTION public.fn_validate_booking_slot()
RETURNS TRIGGER AS $$
DECLARE
  v_approved BOOLEAN;
  v_new_end TIMESTAMPTZ;
  v_conflict_exists BOOLEAN;
  v_blocked BOOLEAN;
BEGIN
  SELECT pr.is_approved INTO v_approved
  FROM public.professionals pr
  JOIN public.profiles p ON p.id = pr.user_id
  WHERE pr.id = NEW.professional_id AND p.status = 'active';

  IF NOT COALESCE(v_approved, FALSE) THEN
    RAISE EXCEPTION 'Profissional não aprovado ou inativo.';
  END IF;

  v_new_end := NEW.scheduled_at + (NEW.duration_minutes || ' minutes')::INTERVAL;

  SELECT EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.professional_id = NEW.professional_id
      AND b.id <> NEW.id
      AND b.status NOT IN ('cancelada', 'expirou')
      AND b.scheduled_at < v_new_end
      AND (b.scheduled_at + (b.duration_minutes || ' minutes')::INTERVAL) > NEW.scheduled_at
  ) INTO v_conflict_exists;

  IF v_conflict_exists THEN
    RAISE EXCEPTION 'Conflito de agenda: já existe reserva neste intervalo para o profissional.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.professional_availability_blocks blk
    WHERE blk.professional_id = NEW.professional_id
      AND blk.starts_at < v_new_end
      AND blk.ends_at > NEW.scheduled_at
  ) INTO v_blocked;

  IF v_blocked THEN
    RAISE EXCEPTION 'Profissional possui bloqueio de agenda neste período.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_booking_slot
  BEFORE INSERT ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.fn_validate_booking_slot();

-- 6. Safe single-coupon lookup RPC (prevents listing all coupons)
CREATE OR REPLACE FUNCTION public.fn_validate_coupon(p_code TEXT)
RETURNS TABLE (code TEXT, discount_type discount_type_enum, discount_value NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.code, c.discount_type, c.discount_value
  FROM public.coupons c
  WHERE UPPER(c.code) = UPPER(trim(p_code))
    AND c.is_active = TRUE
    AND (c.expiration_date IS NULL OR c.expiration_date > NOW())
    AND (c.usage_limit IS NULL OR c.usage_count < c.usage_limit)
  LIMIT 1;
$$;

-- 7. Atomic payment confirmation & immutable ledger posting (called by Edge Function / service_role)
CREATE OR REPLACE FUNCTION public.fn_process_confirmed_payment(
  p_payment_id UUID,
  p_provider_payment_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay RECORD;
  v_call_id UUID;
  v_fee NUMERIC(12,2);
  v_pro_share NUMERIC(12,2);
BEGIN
  SELECT py.*, b.professional_id, b.is_instant, pr.commission_percentage
  INTO v_pay
  FROM public.payments py
  JOIN public.bookings b ON b.id = py.booking_id
  JOIN public.professionals pr ON pr.id = b.professional_id
  WHERE py.id = p_payment_id
  FOR UPDATE OF py;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pagamento não encontrado';
  END IF;

  IF v_pay.status = 'approved' THEN
    SELECT id INTO v_call_id FROM public.video_calls WHERE booking_id = v_pay.booking_id;
    RETURN v_call_id;
  END IF;

  v_fee := ROUND((v_pay.amount * v_pay.commission_percentage) / 100.0, 2);
  v_pro_share := v_pay.amount - v_fee;

  UPDATE public.payments
  SET status = 'approved', provider_payment_id = p_provider_payment_id, paid_at = NOW()
  WHERE id = p_payment_id;

  UPDATE public.bookings
  SET status = 'pagamento_confirmado'
  WHERE id = v_pay.booking_id;

  INSERT INTO public.video_calls (booking_id, client_id, professional_id, room_name, call_status, amount)
  VALUES (
    v_pay.booking_id,
    v_pay.client_id,
    v_pay.professional_id,
    'aurum-' || replace(v_pay.booking_id::TEXT, '-', ''),
    CASE WHEN v_pay.is_instant THEN 'aguardando_profissional'::call_status_enum ELSE 'pagamento_confirmado'::call_status_enum END,
    v_pay.amount
  )
  RETURNING id INTO v_call_id;

  INSERT INTO public.financial_transactions (
    payment_id, professional_id, client_id, booking_id, transaction_type,
    gross_amount, platform_fee, professional_amount, currency
  ) VALUES (
    p_payment_id, v_pay.professional_id, v_pay.client_id, v_pay.booking_id, 'session_credit',
    v_pay.amount, v_fee, v_pro_share, 'BRL'
  );

  UPDATE public.professional_balances
  SET pending_balance = pending_balance + v_pro_share
  WHERE professional_id = v_pay.professional_id;

  RETURN v_call_id;
END;
$$;

-- 8. Atomic payout request RPC for authenticated professionals
CREATE OR REPLACE FUNCTION public.fn_request_payout(
  p_amount NUMERIC,
  p_payout_method TEXT,
  p_payout_details JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pro_id UUID;
  v_avail NUMERIC(12,2);
  v_payout_id UUID;
BEGIN
  v_pro_id := public.auth_professional_id();
  IF v_pro_id IS NULL THEN
    RAISE EXCEPTION 'Acesso restrito a profissionais ativos.';
  END IF;

  SELECT available_balance INTO v_avail
  FROM public.professional_balances
  WHERE professional_id = v_pro_id
  FOR UPDATE;

  IF COALESCE(v_avail, 0) < p_amount OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Saldo disponível insuficiente.';
  END IF;

  UPDATE public.professional_balances
  SET available_balance = available_balance - p_amount
  WHERE professional_id = v_pro_id;

  INSERT INTO public.payout_requests (professional_id, amount, payout_method, payout_details, status)
  VALUES (v_pro_id, p_amount, p_payout_method, p_payout_details, 'pending')
  RETURNING id INTO v_payout_id;

  RETURN v_payout_id;
END;
$$;
