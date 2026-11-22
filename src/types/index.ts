export type UserRole = 'admin' | 'professional' | 'client';
export type AccountStatus = 'active' | 'pending' | 'suspended' | 'blocked';
export type AvailabilityStatus = 'online' | 'offline' | 'busy';

export type BookingStatus =
  | 'aguardando_pagamento'
  | 'pagamento_confirmado'
  | 'em_andamento'
  | 'finalizada'
  | 'cancelada'
  | 'expirou';

export type CallStatus =
  | 'aguardando_pagamento'
  | 'pagamento_confirmado'
  | 'aguardando_profissional'
  | 'aguardando_cliente'
  | 'iniciando'
  | 'em_andamento'
  | 'finalizada'
  | 'cancelada'
  | 'recusada'
  | 'expirou'
  | 'falha';

export interface ProfessionalProfile {
  id: string;
  user_id?: string;
  professional_name: string;
  slug: string;
  bio: string;
  category: string;
  languages: string[];
  profile_image: string | null;
  gallery: string[];
  price_per_session_cents: number;
  price_per_minute_cents: number;
  session_duration: number;
  commission_percentage?: number;
  availability_status: AvailabilityStatus;
  is_approved?: number;
  is_featured?: number;
  instant_call_enabled?: number;
  is_demo?: number;
  rating_avg?: number;
  review_count?: number;
  full_name?: string;
  email?: string;
  phone?: string;
  account_status?: AccountStatus;
  available_cents?: number;
  pending_cents?: number;
  paid_cents?: number;
}

export interface AuthUser {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
  user_role: UserRole;
  status: AccountStatus;
  is_demo: number;
  created_at: string;
  professional?: ProfessionalProfile | null;
  client?: { id: string; user_id: string } | null;
}

export interface AvailabilitySlot {
  id: string;
  professional_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_available: number;
}

export interface ReviewItem {
  id: string;
  client_name: string;
  professional_name?: string;
  rating: number;
  comment: string;
  status: string;
  created_at: string;
}

export interface BookingItem {
  id: string;
  client_id: string;
  professional_id: string;
  scheduled_at: string;
  duration_minutes: number;
  billing_mode: 'session' | 'per_minute';
  amount_cents: number;
  coupon_code: string | null;
  discount_cents: number;
  status: BookingStatus;
  cancellation_reason: string | null;
  is_instant: number;
  is_demo: number;
  professional_name?: string;
  client_name?: string;
  client_email?: string;
  slug?: string;
  category?: string;
  profile_image?: string | null;
  video_call_id?: string | null;
  call_status?: CallStatus | null;
  duration_seconds?: number | null;
  review_id?: string | null;
}

export interface NotificationItem {
  id: string;
  user_id: string;
  title: string;
  message: string;
  type: string;
  read_at: string | null;
  created_at: string;
}
