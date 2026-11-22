-- ==============================================================================
-- AURUM PRIVÉ — ROW LEVEL SECURITY POLICIES (002_rls_policies.sql)
-- ==============================================================================

-- Role-resolution helpers (SECURITY DEFINER + pinned search_path)
CREATE OR REPLACE FUNCTION public.auth_is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users au
    JOIN public.profiles p ON p.id = au.user_id
    WHERE au.user_id = auth.uid()
      AND p.user_role = 'admin'
      AND p.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_professional_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pr.id
  FROM public.professionals pr
  JOIN public.profiles p ON p.id = pr.user_id
  WHERE pr.user_id = auth.uid()
    AND p.user_role = 'professional'
    AND p.status = 'active'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.auth_client_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id
  FROM public.clients c
  JOIN public.profiles p ON p.id = c.user_id
  WHERE c.user_id = auth.uid()
    AND p.status = 'active'
  LIMIT 1;
$$;

-- Enable RLS across ALL exposed tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professional_client_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professional_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professional_availability_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professional_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 1. PROFILES
-- Users read own profile; Professionals can read basic profile of clients who booked them; Admins read all.
CREATE POLICY profiles_select_scoped ON public.profiles
  FOR SELECT USING (
    id = auth.uid()
    OR public.auth_is_admin()
    OR (
      public.auth_professional_id() IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.clients c
        JOIN public.bookings b ON b.client_id = c.id
        WHERE c.user_id = profiles.id
          AND b.professional_id = public.auth_professional_id()
      )
    )
  );

-- Users can update ONLY safe personal fields (role & status locked)
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND user_role = (SELECT p.user_role FROM public.profiles p WHERE p.id = auth.uid())
    AND status = (SELECT p.status FROM public.profiles p WHERE p.id = auth.uid())
  );

CREATE POLICY profiles_admin_all ON public.profiles
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

-- 2. ADMIN USERS (Read-only for verified admins; writes via service_role only)
CREATE POLICY admin_users_select_admin ON public.admin_users
  FOR SELECT USING (public.auth_is_admin());

-- 3. PROFESSIONALS
CREATE POLICY professionals_public_approved ON public.professionals
  FOR SELECT USING (
    is_approved = TRUE
    AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = professionals.user_id AND p.status = 'active'
    )
  );

CREATE POLICY professionals_select_own ON public.professionals
  FOR SELECT USING (user_id = auth.uid() OR public.auth_is_admin());

-- Professional can edit bio/languages/status/gallery, NEVER approval or commission_percentage
CREATE POLICY professionals_update_own ON public.professionals
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND is_approved = (SELECT pr.is_approved FROM public.professionals pr WHERE pr.id = professionals.id)
    AND is_featured = (SELECT pr.is_featured FROM public.professionals pr WHERE pr.id = professionals.id)
    AND commission_percentage = (SELECT pr.commission_percentage FROM public.professionals pr WHERE pr.id = professionals.id)
    AND price_per_session = (SELECT pr.price_per_session FROM public.professionals pr WHERE pr.id = professionals.id)
    AND price_per_minute = (SELECT pr.price_per_minute FROM public.professionals pr WHERE pr.id = professionals.id)
  );

CREATE POLICY professionals_admin_all ON public.professionals
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

-- 4. CLIENTS & PRIVATE CRM NOTES
CREATE POLICY clients_select_scoped ON public.clients
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.auth_is_admin()
    OR EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.client_id = clients.id AND b.professional_id = public.auth_professional_id()
    )
  );

CREATE POLICY clients_admin_all ON public.clients
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

CREATE POLICY crm_notes_pro_own ON public.professional_client_notes
  FOR ALL USING (
    professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  )
  WITH CHECK (
    professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  );

-- 5. PROFESSIONAL AVAILABILITY & BLOCKS
CREATE POLICY availability_public_read ON public.professional_availability
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.professionals pr WHERE pr.id = professional_id AND pr.is_approved = TRUE)
    OR professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  );

CREATE POLICY availability_pro_manage ON public.professional_availability
  FOR ALL USING (
    professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  )
  WITH CHECK (
    professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  );

CREATE POLICY blocks_pro_manage ON public.professional_availability_blocks
  FOR ALL USING (
    professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  )
  WITH CHECK (
    professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  );

-- 6. BOOKINGS & VIDEO CALLS
CREATE POLICY bookings_participant_read ON public.bookings
  FOR SELECT USING (
    client_id = public.auth_client_id()
    OR professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  );

CREATE POLICY bookings_client_insert ON public.bookings
  FOR INSERT WITH CHECK (
    client_id = public.auth_client_id()
    AND status = 'aguardando_pagamento'
  );

CREATE POLICY bookings_admin_all ON public.bookings
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

CREATE POLICY video_calls_participant_read ON public.video_calls
  FOR SELECT USING (
    client_id = public.auth_client_id()
    OR professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  );

CREATE POLICY video_calls_admin_all ON public.video_calls
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

-- 7. PAYMENTS, LEDGER, BALANCES & PAYOUTS (Strictly tamper-proof from client/pro writes)
CREATE POLICY payments_participant_read ON public.payments
  FOR SELECT USING (
    client_id = public.auth_client_id()
    OR public.auth_is_admin()
  );

CREATE POLICY financial_tx_scoped_read ON public.financial_transactions
  FOR SELECT USING (
    professional_id = public.auth_professional_id()
    OR client_id = public.auth_client_id()
    OR public.auth_is_admin()
  );

CREATE POLICY balances_pro_read ON public.professional_balances
  FOR SELECT USING (
    professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  );

CREATE POLICY payouts_pro_read ON public.payout_requests
  FOR SELECT USING (
    professional_id = public.auth_professional_id()
    OR public.auth_is_admin()
  );

CREATE POLICY payouts_admin_all ON public.payout_requests
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

-- 8. REVIEWS, FAVORITES, COUPONS, NOTIFICATIONS, SETTINGS & AUDIT
CREATE POLICY reviews_public_read ON public.reviews
  FOR SELECT USING (status = 'published' OR public.auth_is_admin());

CREATE POLICY reviews_client_insert ON public.reviews
  FOR INSERT WITH CHECK (
    client_id = public.auth_client_id()
    AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = booking_id AND b.client_id = public.auth_client_id() AND b.status = 'finalizada'
    )
  );

CREATE POLICY reviews_admin_manage ON public.reviews
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

CREATE POLICY favorites_client_own ON public.favorites
  FOR ALL USING (client_id = public.auth_client_id() OR public.auth_is_admin())
  WITH CHECK (client_id = public.auth_client_id() OR public.auth_is_admin());

CREATE POLICY coupons_admin_only ON public.coupons
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

CREATE POLICY notifications_own_read ON public.notifications
  FOR SELECT USING (user_id = auth.uid() OR public.auth_is_admin());

CREATE POLICY notifications_own_update ON public.notifications
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY settings_admin_only ON public.platform_settings
  FOR ALL USING (public.auth_is_admin())
  WITH CHECK (public.auth_is_admin());

CREATE POLICY audit_logs_admin_read ON public.audit_logs
  FOR SELECT USING (public.auth_is_admin());

-- 9. SUPABASE STORAGE BUCKET POLICIES
CREATE POLICY "Public read avatars and approved galleries"
  ON storage.objects FOR SELECT
  USING (bucket_id IN ('avatars', 'professional-galleries'));

CREATE POLICY "Authenticated upload own folder avatar"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id IN ('avatars', 'professional-galleries')
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Authenticated update own folder avatar"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id IN ('avatars', 'professional-galleries')
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
