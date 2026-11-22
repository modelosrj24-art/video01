import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, Calendar, CreditCard, Heart, LayoutDashboard, User, Video } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { bookingStatusLabel, formatBRL, formatDateTime, formatDurationSeconds, formatMoney, gatewayLabel } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import type { BookingItem, NotificationItem, ProfessionalProfile } from '../../types';
import { DashboardShell, type SidebarItem } from '../../components/ui/DashboardShell';
import { ProfileAvatar } from '../../components/ui/RevenueChart';
import { BookingCheckoutModal } from '../../components/ui/BookingCheckoutModal';

const CLIENT_SIDEBAR: SidebarItem[] = [
  { to: '/cliente/dashboard', label: 'Visão geral', icon: <LayoutDashboard className="w-4 h-4" /> },
  { to: '/cliente/agendamentos', label: 'Agendamentos', icon: <Calendar className="w-4 h-4" /> },
  { to: '/cliente/chamadas', label: 'Videochamadas', icon: <Video className="w-4 h-4" /> },
  { to: '/cliente/pagamentos', label: 'Pagamentos', icon: <CreditCard className="w-4 h-4" /> },
  { to: '/cliente/favoritos', label: 'Favoritos', icon: <Heart className="w-4 h-4" /> },
  { to: '/cliente/perfil', label: 'Meu perfil', icon: <User className="w-4 h-4" /> },
  { to: '/cliente/notificacoes', label: 'Notificações', icon: <Bell className="w-4 h-4" /> },
];

export function ClientPortal({
  section,
}: {
  section: 'dashboard' | 'profile' | 'favorites' | 'bookings' | 'calls' | 'payments' | 'notifications';
}) {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [dashboard, setDashboard] = useState<{
    stats: { total_bookings: number; upcoming_count: number; completed_count: number };
    totalSpentCents: number;
    bookings: BookingItem[];
    favorites: ProfessionalProfile[];
  } | null>(null);
  const [bookings, setBookings] = useState<BookingItem[]>([]);
  const [calls, setCalls] = useState<Array<Record<string, unknown>>>([]);
  const [payments, setPayments] = useState<Array<Record<string, unknown>>>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  const [fullName, setFullName] = useState(user?.full_name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [profileSaved, setProfileSaved] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [payingBooking, setPayingBooking] = useState<BookingItem | null>(null);

  async function loadSection() {
    setLoading(true);
    try {
      if (section === 'dashboard' || section === 'favorites') {
        const res = await apiFetch<NonNullable<typeof dashboard>>('/api/client/dashboard');
        setDashboard(res);
      } else if (section === 'bookings') {
        const res = await apiFetch<{ bookings: BookingItem[] }>('/api/client/bookings');
        setBookings(res.bookings);
      } else if (section === 'calls') {
        const res = await apiFetch<{ calls: Array<Record<string, unknown>> }>('/api/client/calls');
        setCalls(res.calls);
      } else if (section === 'payments') {
        const res = await apiFetch<{ payments: Array<Record<string, unknown>> }>('/api/client/payments');
        setPayments(res.payments);
      } else if (section === 'notifications') {
        const res = await apiFetch<{ notifications: NotificationItem[] }>('/api/client/notifications');
        setNotifications(res.notifications);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSection();
  }, [section]);

  // Handle redirect return from PayPal or Mercado Pago Checkout
  useEffect(() => {
    const gateway = searchParams.get('gateway');
    const payResult = searchParams.get('payment');
    const paymentId = searchParams.get('paymentId');
    const ppToken = searchParams.get('token');
    if (!paymentId || !payResult) return;

    (async () => {
      try {
        if (gateway === 'paypal' && payResult === 'success') {
          const cap = await apiFetch<{ status: string }>(`/api/payments/${paymentId}/capture`, {
            method: 'POST',
            body: JSON.stringify({ orderId: ppToken || undefined }),
          });
          if (cap.status === 'approved') {
            setActionMessage('Pagamento PayPal capturado e confirmado. Sua sala privada foi liberada.');
          }
        } else if (payResult === 'cancelled' || payResult === 'failure') {
          setActionMessage('O pagamento no gateway não foi concluído. Você pode tentar novamente com qualquer gateway ativo.');
        } else if (payResult === 'success') {
          await apiFetch(`/api/payments/${paymentId}/status`);
          setActionMessage('Status do pagamento sincronizado com o gateway.');
        }
      } catch (err) {
        setActionMessage(err instanceof Error ? err.message : 'Não foi possível concluir a validação do retorno do gateway.');
      } finally {
        setSearchParams({}, { replace: true });
        loadSection();
      }
    })();
  }, [searchParams, setSearchParams]);

  async function handleCancelBooking(id: string) {
    setActionMessage('');
    const res = await apiFetch<{ ok: boolean; refunded?: boolean; notice?: string }>(`/api/client/bookings/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Cancelamento solicitado pelo cliente' }),
    });
    if (res.refunded) {
      setActionMessage('Reserva cancelada e estorno processado automaticamente para o pagamento aprovado.');
    } else if (res.notice) {
      setActionMessage(res.notice);
    } else {
      setActionMessage('Agendamento cancelado.');
    }
    loadSection();
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    await apiFetch('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ fullName, phone }),
    });
    await refreshUser();
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
  }

  const titles: Record<typeof section, string> = {
    dashboard: 'Painel do Cliente',
    bookings: 'Meus Agendamentos',
    calls: 'Minhas Videochamadas',
    payments: 'Histórico de Pagamentos',
    favorites: 'Profissionais Favoritos',
    profile: 'Meu Perfil',
    notifications: 'Notificações',
  };

  return (
    <DashboardShell
      title={titles[section]}
      breadcrumb={`Cliente / ${titles[section]}`}
      items={CLIENT_SIDEBAR}
      headerAction={
        <Link
          to="/profissionais"
          className="px-4 py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] whitespace-nowrap"
        >
          Nova sessão
        </Link>
      }
    >
      {loading && section !== 'profile' ? (
        <div className="h-64 rounded-2xl border border-white/10 bg-[#111115] animate-pulse" />
      ) : section === 'dashboard' && dashboard ? (
        <div className="space-y-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Sessões confirmadas</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#E5C97B] mt-1">
                {dashboard.stats.upcoming_count || 0}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Atendimentos concluídos</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {dashboard.stats.completed_count || 0}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Total investido</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {formatBRL(dashboard.totalSpentCents)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Favoritos</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {dashboard.favorites.length}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] p-6">
            <h2 className="font-display text-xl font-semibold mb-4">Próximos atendimentos</h2>
            {dashboard.bookings.length === 0 ? (
              <p className="text-xs text-zinc-400">Nenhum agendamento encontrado.</p>
            ) : (
              <div className="divide-y divide-white/10">
                {dashboard.bookings.map((b) => {
                  const st = bookingStatusLabel(b.status);
                  return (
                    <div key={b.id} className="py-4 flex flex-wrap items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <ProfileAvatar src={b.profile_image} name={b.professional_name || 'P'} className="w-11 h-11" />
                        <div>
                          <div className="text-sm font-semibold text-[#F5F2EB]">{b.professional_name}</div>
                          <div className="text-xs text-zinc-400 font-mono tabular-nums">
                            {formatDateTime(b.scheduled_at)} · {b.duration_minutes} min · {formatBRL(b.amount_cents)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-medium ${st.colorClass}`}>{st.label}</span>
                        {b.video_call_id && b.status === 'pagamento_confirmado' && (
                          <button
                            type="button"
                            onClick={() => navigate(`/sala/${b.video_call_id}`)}
                            className="px-4 py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] cursor-pointer"
                          >
                            Entrar na sala
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : section === 'bookings' ? (
        <div className="space-y-4">
          {actionMessage && (
            <div className="p-3.5 rounded-xl border border-[#D4AF37]/30 bg-[#D4AF37]/10 text-xs text-[#E5C97B]">
              {actionMessage}
            </div>
          )}
          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Profissional</th>
                    <th className="py-3.5 px-5 font-medium">Data e horário</th>
                    <th className="py-3.5 px-5 font-medium">Duração</th>
                    <th className="py-3.5 px-5 font-medium">Valor</th>
                    <th className="py-3.5 px-5 font-medium">Status</th>
                    <th className="py-3.5 px-5 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {bookings.map((b) => {
                    const st = bookingStatusLabel(b.status);
                    return (
                      <tr key={b.id} className="hover:bg-white/[0.02]">
                        <td className="py-3.5 px-5 font-medium text-[#F5F2EB]">{b.professional_name}</td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">{formatDateTime(b.scheduled_at)}</td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">{b.duration_minutes} min</td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">{formatBRL(b.amount_cents)}</td>
                        <td className={`py-3.5 px-5 font-medium ${st.colorClass}`}>{st.label}</td>
                        <td className="py-3.5 px-5 text-right space-x-2 whitespace-nowrap">
                          {b.status === 'aguardando_pagamento' && (
                            <button
                              type="button"
                              onClick={() => setPayingBooking(b)}
                              className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#09090B] font-semibold cursor-pointer"
                            >
                              Pagar agora
                            </button>
                          )}
                          {b.video_call_id && (b.status === 'pagamento_confirmado' || b.status === 'em_andamento') && (
                            <button
                              type="button"
                              onClick={() => navigate(`/sala/${b.video_call_id}`)}
                              className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#09090B] font-semibold cursor-pointer"
                            >
                              Entrar
                            </button>
                          )}
                          {(b.status === 'aguardando_pagamento' || b.status === 'pagamento_confirmado') && (
                            <button
                              type="button"
                              onClick={() => handleCancelBooking(b.id)}
                              className="px-3 py-1.5 rounded border border-white/15 text-zinc-300 hover:text-red-400 cursor-pointer"
                            >
                              Cancelar
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : section === 'calls' ? (
        <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-zinc-400">
                <tr>
                  <th className="py-3.5 px-5 font-medium">Profissional</th>
                  <th className="py-3.5 px-5 font-medium">Sala</th>
                  <th className="py-3.5 px-5 font-medium">Duração real</th>
                  <th className="py-3.5 px-5 font-medium">Status</th>
                  <th className="py-3.5 px-5 font-medium text-right">Acesso</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {calls.map((c) => {
                  const st = bookingStatusLabel(String(c.call_status));
                  const canEnter = ['pagamento_confirmado', 'aguardando_profissional', 'aguardando_cliente', 'em_andamento'].includes(
                    String(c.call_status)
                  );
                  return (
                    <tr key={String(c.id)}>
                      <td className="py-3.5 px-5 font-medium text-[#F5F2EB]">{String(c.professional_name)}</td>
                      <td className="py-3.5 px-5 font-mono text-zinc-400">{String(c.room_name)}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                        {formatDurationSeconds(Number(c.duration_seconds || 0))}
                      </td>
                      <td className={`py-3.5 px-5 font-medium ${st.colorClass}`}>{st.label}</td>
                      <td className="py-3.5 px-5 text-right">
                        {canEnter ? (
                          <button
                            type="button"
                            onClick={() => navigate(`/sala/${c.id}`)}
                            className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#09090B] font-semibold cursor-pointer"
                          >
                            Acessar sala
                          </button>
                        ) : (
                          <span className="text-zinc-500">Encerrada</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : section === 'payments' ? (
        <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-zinc-400">
                <tr>
                  <th className="py-3.5 px-5 font-medium">Profissional</th>
                  <th className="py-3.5 px-5 font-medium">Gateway / Método</th>
                  <th className="py-3.5 px-5 font-medium">Valor</th>
                  <th className="py-3.5 px-5 font-medium">Status</th>
                  <th className="py-3.5 px-5 font-medium">Data</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {payments.map((p) => {
                  const st = bookingStatusLabel(String(p.status));
                  return (
                    <tr key={String(p.id)}>
                      <td className="py-3.5 px-5 font-medium text-[#F5F2EB]">{String(p.professional_name)}</td>
                      <td className="py-3.5 px-5 text-zinc-400">
                        <span className="text-zinc-200 font-medium">{gatewayLabel(String(p.provider))}</span>
                        <span className="mx-1.5 text-zinc-600">·</span>
                        <span className="uppercase">{String(p.payment_method)}</span>
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                        {formatMoney(Number(p.amount_cents), String(p.currency || 'BRL'))}
                      </td>
                      <td className={`py-3.5 px-5 font-medium ${st.colorClass}`}>{st.label}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">
                        {formatDateTime(String(p.confirmed_at || p.paid_at || p.created_at))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : section === 'favorites' && dashboard ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {dashboard.favorites.length === 0 ? (
            <div className="col-span-full rounded-2xl border border-white/10 bg-[#111115] p-8 text-center text-xs text-zinc-400">
              Você ainda não favoritou nenhum profissional.
            </div>
          ) : (
            dashboard.favorites.map((pro) => (
              <div key={pro.id} className="rounded-2xl border border-white/10 bg-[#111115] p-5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <ProfileAvatar src={pro.profile_image} name={pro.professional_name} className="w-12 h-12" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#F5F2EB] truncate">{pro.professional_name}</div>
                    <div className="text-xs text-zinc-400 truncate">{pro.category}</div>
                  </div>
                </div>
                <Link
                  to={`/profissional/${pro.slug}`}
                  className="px-3 py-1.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold shrink-0"
                >
                  Ver perfil
                </Link>
              </div>
            ))
          )}
        </div>
      ) : section === 'notifications' ? (
        <div className="rounded-2xl border border-white/10 bg-[#111115] divide-y divide-white/10">
          {notifications.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-400">Nenhuma notificação registrada.</div>
          ) : (
            notifications.map((n) => (
              <div key={n.id} className="p-5 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-[#F5F2EB]">{n.title}</div>
                  <div className="text-xs text-zinc-400 mt-1">{n.message}</div>
                  <div className="text-[11px] text-zinc-500 mt-1 font-mono">{formatDateTime(n.created_at)}</div>
                </div>
                {!n.read_at && (
                  <button
                    type="button"
                    onClick={async () => {
                      await apiFetch(`/api/client/notifications/${n.id}/read`, { method: 'POST' });
                      loadSection();
                    }}
                    className="text-xs text-[#E5C97B] hover:underline shrink-0 cursor-pointer"
                  >
                    Marcar como lida
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      ) : (
        <form onSubmit={handleSaveProfile} className="max-w-lg rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-4">
          {profileSaved && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
              Perfil atualizado com sucesso.
            </div>
          )}
          <div>
            <label className="block text-xs text-zinc-300 mb-1.5">Nome completo</label>
            <input
              required
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-300 mb-1.5">E-mail</label>
            <input
              disabled
              type="email"
              value={user?.email || ''}
              className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B]/50 border border-white/10 text-sm text-zinc-500"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-300 mb-1.5">Telefone</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
            />
          </div>
          <button
            type="submit"
            className="px-5 py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] cursor-pointer"
          >
            Salvar alterações
          </button>
        </form>
      )}
      {payingBooking && (
        <BookingCheckoutModal
          professional={{
            id: payingBooking.professional_id,
            professional_name: payingBooking.professional_name || 'Profissional',
            category: payingBooking.category || 'Atendimento Privado',
            price_per_session_cents: payingBooking.amount_cents,
            price_per_minute_cents: 0,
            session_duration: payingBooking.duration_minutes,
          }}
          mode="pay_existing"
          existingBooking={{
            id: payingBooking.id,
            amount_cents: payingBooking.amount_cents,
            duration_minutes: payingBooking.duration_minutes,
          }}
          onPaid={() => loadSection()}
          onClose={() => {
            setPayingBooking(null);
            loadSection();
          }}
        />
      )}
    </DashboardShell>
  );
}
