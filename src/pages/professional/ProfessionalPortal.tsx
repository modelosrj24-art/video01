import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell,
  Calendar,
  CheckCheck,
  Clock,
  DollarSign,
  Download,
  ExternalLink,
  History,
  LayoutDashboard,
  Lock,
  Percent,
  Plus,
  Search,
  Star,
  Trash2,
  User,
  Users,
  Video,
  Wallet,
} from 'lucide-react';
import { apiFetch, exportToCsv } from '../../lib/api';
import { bookingStatusLabel, DAY_NAMES_PT, formatBRL, formatDateTime, formatDurationSeconds } from '../../lib/format';
import { DashboardShell, type SidebarItem } from '../../components/ui/DashboardShell';
import { RevenueChart, ProfileAvatar } from '../../components/ui/RevenueChart';

const PRO_SIDEBAR: SidebarItem[] = [
  { to: '/profissional/dashboard', label: 'Meu dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  { to: '/profissional/perfil', label: 'Meu perfil', icon: <User className="w-4 h-4" /> },
  { to: '/profissional/agenda', label: 'Agenda e horários', icon: <Calendar className="w-4 h-4" /> },
  { to: '/profissional/chamadas', label: 'Videochamadas', icon: <Video className="w-4 h-4" /> },
  { to: '/profissional/clientes', label: 'Meus clientes (CRM)', icon: <Users className="w-4 h-4" /> },
  { to: '/profissional/financeiro', label: 'Ganhos e comissões', icon: <DollarSign className="w-4 h-4" /> },
  { to: '/profissional/saques', label: 'Solicitações de saque', icon: <Wallet className="w-4 h-4" /> },
  { to: '/profissional/notificacoes', label: 'Notificações', icon: <Bell className="w-4 h-4" /> },
];

const LANGUAGE_OPTIONS = ['Português', 'Inglês', 'Espanhol', 'Francês', 'Italiano', 'Alemão'];

function formatPayoutDetails(raw: unknown): string {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
    if (parsed?.pixKey) return `PIX: ${String(parsed.pixKey)}`;
    if (parsed?.bankAccount) return `TED: ${String(parsed.bankAccount)}`;
    return String(raw || '');
  } catch {
    return String(raw || '');
  }
}

function transactionTypeLabel(type: string): { label: string; colorClass: string } {
  switch (type) {
    case 'session_credit':
      return { label: 'Crédito de atendimento', colorClass: 'text-emerald-400' };
    case 'refund_debit':
      return { label: 'Estorno de sessão', colorClass: 'text-red-400' };
    case 'payout_debit':
      return { label: 'Repasse efetuado', colorClass: 'text-zinc-300' };
    case 'adjustment':
      return { label: 'Ajuste administrativo', colorClass: 'text-[#E5C97B]' };
    default:
      return { label: type, colorClass: 'text-zinc-300' };
  }
}

export function ProfessionalPortal({
  section,
}: {
  section: 'dashboard' | 'profile' | 'agenda' | 'calls' | 'clients' | 'financials' | 'payouts' | 'notifications';
}) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savedNotice, setSavedNotice] = useState('');

  // Dashboard & Profile
  const [dashPeriod, setDashPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [dash, setDash] = useState<Record<string, any> | null>(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [professionalName, setProfessionalName] = useState('');
  const [bio, setBio] = useState('');
  const [profileImage, setProfileImage] = useState('');
  const [languages, setLanguages] = useState<string[]>(['Português']);
  const [status, setStatus] = useState<'online' | 'offline' | 'busy'>('online');
  const [instantEnabled, setInstantEnabled] = useState(true);
  const [proReviews, setProReviews] = useState<Array<Record<string, any>>>([]);

  // Agenda & Availability
  const [agendaTab, setAgendaTab] = useState<'bookings' | 'availability'>('bookings');
  const [bookings, setBookings] = useState<Array<Record<string, any>>>([]);
  const [bookingSearch, setBookingSearch] = useState('');
  const [bookingStatusFilter, setBookingStatusFilter] = useState('all');
  const [slots, setSlots] = useState<Array<{ day_of_week: number; start_time: string; end_time: string; is_available: boolean }>>([]);
  const [blocks, setBlocks] = useState<Array<Record<string, any>>>([]);
  const [newBlockDate, setNewBlockDate] = useState('');
  const [newBlockStart, setNewBlockStart] = useState('');
  const [newBlockEnd, setNewBlockEnd] = useState('');
  const [newBlockReason, setNewBlockReason] = useState('');

  // Calls
  const [calls, setCalls] = useState<Array<Record<string, any>>>([]);
  const [callSummary, setCallSummary] = useState<Record<string, any> | null>(null);
  const [callSearch, setCallSearch] = useState('');
  const [callStatusFilter, setCallStatusFilter] = useState('all');

  // CRM Clients
  const [clients, setClients] = useState<Array<Record<string, any>>>([]);
  const [clientSearch, setClientSearch] = useState('');
  const [editingNoteClientId, setEditingNoteClientId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [expandedHistoryClientId, setExpandedHistoryClientId] = useState<string | null>(null);
  const [clientHistory, setClientHistory] = useState<Array<Record<string, any>>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Financials & Payouts
  const [financials, setFinancials] = useState<Record<string, any> | null>(null);
  const [txTypeFilter, setTxTypeFilter] = useState('all');
  const [txFrom, setTxFrom] = useState('');
  const [txTo, setTxTo] = useState('');
  const [payoutBRL, setPayoutBRL] = useState('100');
  const [payoutMethod, setPayoutMethod] = useState<'pix' | 'ted'>('pix');
  const [pixKey, setPixKey] = useState('');
  const [tedDetails, setTedDetails] = useState('');

  // Notifications
  const [notifications, setNotifications] = useState<Array<Record<string, any>>>([]);
  const [notifFilter, setNotifFilter] = useState<'all' | 'unread'>('all');

  function flashNotice(msg: string) {
    setSavedNotice(msg);
    setTimeout(() => setSavedNotice(''), 3200);
  }

  async function runAction(action: () => Promise<void>, successMessage?: string) {
    setError('');
    try {
      await action();
      if (successMessage) flashNotice(successMessage);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao executar operação.');
    }
  }

  async function loadData() {
    setLoading(true);
    setError('');
    try {
      if (section === 'dashboard' || section === 'profile') {
        const requests: [Promise<Record<string, any>>, Promise<{ reviews: Array<Record<string, any>> }> | null] = [
          apiFetch<Record<string, any>>(`/api/professional/dashboard?period=${dashPeriod}`),
          section === 'profile' ? apiFetch<{ reviews: Array<Record<string, any>> }>('/api/professional/reviews') : null,
        ];
        const res = await requests[0];
        setDash(res);
        setFullName(res.professional.full_name || '');
        setPhone(res.professional.phone || '');
        setProfessionalName(res.professional.professional_name || '');
        setBio(res.professional.bio || '');
        setProfileImage(res.professional.profile_image || '');
        setLanguages(Array.isArray(res.professional.languages) && res.professional.languages.length > 0 ? res.professional.languages : ['Português']);
        setStatus(res.professional.availability_status || 'offline');
        setInstantEnabled(Boolean(res.professional.instant_call_enabled));
        if (requests[1]) {
          const revRes = await requests[1];
          setProReviews(revRes.reviews);
        }
      } else if (section === 'agenda') {
        const bParams = new URLSearchParams();
        if (bookingStatusFilter !== 'all') bParams.set('status', bookingStatusFilter);
        if (bookingSearch.trim()) bParams.set('search', bookingSearch.trim());

        const [availRes, bookRes] = await Promise.all([
          apiFetch<{ slots: Array<Record<string, any>>; blocks: Array<Record<string, any>> }>('/api/professional/availability'),
          apiFetch<{ bookings: Array<Record<string, any>> }>(`/api/professional/bookings?${bParams.toString()}`),
        ]);
        setSlots(
          availRes.slots.map((s) => ({
            day_of_week: Number(s.day_of_week),
            start_time: String(s.start_time),
            end_time: String(s.end_time),
            is_available: Boolean(s.is_available),
          }))
        );
        setBlocks(availRes.blocks || []);
        setBookings(bookRes.bookings || []);
      } else if (section === 'calls') {
        const params = new URLSearchParams();
        if (callStatusFilter !== 'all') params.set('status', callStatusFilter);
        if (callSearch.trim()) params.set('search', callSearch.trim());
        const res = await apiFetch<{ calls: Array<Record<string, any>>; summary: Record<string, any> }>(
          `/api/professional/calls?${params.toString()}`
        );
        setCalls(res.calls);
        setCallSummary(res.summary);
      } else if (section === 'clients') {
        const q = clientSearch.trim() ? `?search=${encodeURIComponent(clientSearch.trim())}` : '';
        const res = await apiFetch<{ clients: Array<Record<string, any>> }>(`/api/professional/clients${q}`);
        setClients(res.clients);
      } else if (section === 'financials' || section === 'payouts') {
        const params = new URLSearchParams();
        if (txTypeFilter !== 'all') params.set('type', txTypeFilter);
        if (txFrom) params.set('from', txFrom);
        if (txTo) params.set('to', txTo);
        const res = await apiFetch<Record<string, any>>(`/api/professional/financials?${params.toString()}`);
        setFinancials(res);
      } else if (section === 'notifications') {
        const res = await apiFetch<{ notifications: Array<Record<string, any>> }>('/api/professional/notifications');
        setNotifications(res.notifications);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar dados.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [section, dashPeriod, bookingStatusFilter, bookingSearch, callStatusFilter, callSearch, clientSearch, txTypeFilter, txFrom, txTo]);

  async function handleStatusChange(nextStatus: 'online' | 'offline' | 'busy') {
    setStatus(nextStatus);
    await runAction(async () => {
      await apiFetch('/api/professional/profile', {
        method: 'PATCH',
        body: JSON.stringify({ availabilityStatus: nextStatus }),
      });
    }, `Disponibilidade alterada para ${nextStatus}.`);
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    await runAction(async () => {
      await apiFetch('/api/professional/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          fullName,
          phone,
          professionalName,
          bio,
          languages,
          profileImage,
          availabilityStatus: status,
          instantCallEnabled: instantEnabled,
        }),
      });
    }, 'Perfil profissional atualizado.');
  }

  async function handleSaveAvailability() {
    await runAction(async () => {
      await apiFetch('/api/professional/availability', {
        method: 'PUT',
        body: JSON.stringify({ slots }),
      });
    }, 'Grade semanal salva com sucesso.');
  }

  async function handleAddBlock(e: React.FormEvent) {
    e.preventDefault();
    await runAction(async () => {
      await apiFetch('/api/professional/availability/blocks', {
        method: 'POST',
        body: JSON.stringify({
          blockDate: newBlockDate,
          startTime: newBlockStart,
          endTime: newBlockEnd,
          reason: newBlockReason,
        }),
      });
      setNewBlockDate('');
      setNewBlockStart('');
      setNewBlockEnd('');
      setNewBlockReason('');
    }, 'Bloqueio adicionado à agenda.');
  }

  async function handleCallAction(callId: string, action: 'accept' | 'decline') {
    setError('');
    try {
      await apiFetch(`/api/calls/${callId}/state`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      if (action === 'accept') {
        navigate(`/sala/${callId}`);
      } else {
        flashNotice('Chamada recusada.');
        loadData();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao responder chamada.');
    }
  }

  async function toggleClientHistory(clientId: string) {
    if (expandedHistoryClientId === clientId) {
      setExpandedHistoryClientId(null);
      setClientHistory([]);
      return;
    }
    setExpandedHistoryClientId(clientId);
    setHistoryLoading(true);
    setError('');
    try {
      const res = await apiFetch<{ sessions: Array<Record<string, any>> }>(`/api/professional/clients/${clientId}/history`);
      setClientHistory(res.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar histórico autorizado.');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function handleRequestPayout(e: React.FormEvent) {
    e.preventDefault();
    await runAction(async () => {
      await apiFetch('/api/professional/payouts', {
        method: 'POST',
        body: JSON.stringify({
          amountCents: Math.round(Number(payoutBRL) * 100),
          payoutMethod,
          pixKey: payoutMethod === 'pix' ? pixKey : '',
          tedDetails: payoutMethod === 'ted' ? tedDetails : '',
        }),
      });
      setPixKey('');
      setTedDetails('');
    }, 'Solicitação de saque enviada para análise administrativa.');
  }

  const titles: Record<typeof section, string> = {
    dashboard: 'Meu Dashboard',
    profile: 'Meu Perfil Profissional',
    agenda: 'Agenda e Disponibilidade',
    calls: 'Histórico de Videochamadas',
    clients: 'Meus Clientes Autorizados (CRM)',
    financials: 'Ganhos, Comissões e Saldo',
    payouts: 'Solicitações de Saque e Repasses',
    notifications: 'Notificações',
  };

  const visibleNotifications =
    notifFilter === 'unread' ? notifications.filter((n) => !n.read_at) : notifications;

  return (
    <DashboardShell
      title={titles[section]}
      breadcrumb={`Profissional / ${titles[section]}`}
      items={PRO_SIDEBAR}
      headerAction={
        <div className="flex items-center gap-2">
          {section === 'financials' && financials && (
            <button
              type="button"
              onClick={() => exportToCsv('extrato-profissional-aurum.csv', financials.transactions || [])}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/15 text-xs text-zinc-200 hover:bg-white/5 cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Exportar CSV</span>
            </button>
          )}
          <select
            value={status}
            onChange={(e) => handleStatusChange(e.target.value as 'online' | 'offline' | 'busy')}
            aria-label="Status de disponibilidade"
            className="px-3 py-2 rounded-lg bg-[#111115] border border-white/15 text-xs font-medium text-[#E5C97B] focus:outline-none"
          >
            <option value="online">Online para chamadas</option>
            <option value="busy">Ocupado</option>
            <option value="offline">Offline</option>
          </select>
        </div>
      }
    >
      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-300">{error}</div>
      )}
      {savedNotice && (
        <div className="mb-4 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
          {savedNotice}
        </div>
      )}

      {loading ? (
        <div className="h-64 rounded-2xl border border-white/10 bg-[#111115] animate-pulse" />
      ) : section === 'dashboard' && dash ? (
        <div className="space-y-8">
          {/* KPI Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Saldo disponível</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#E5C97B] mt-1">
                {formatBRL(dash.balance?.available_cents)}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1 font-mono tabular-nums">
                Pendente: {formatBRL(dash.balance?.pending_cents)} · Pago: {formatBRL(dash.balance?.paid_cents)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Ganhos líquidos no mês</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {formatBRL(dash.earningsMonthCents)}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1 font-mono tabular-nums">
                Hoje: {formatBRL(dash.earningsTodayCents)} · 7 dias: {formatBRL(dash.earningsWeekCents)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Atendimentos e avaliação</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {dash.kpis?.completed_sessions || 0} / {dash.kpis?.total_sessions || 0}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1 font-mono tabular-nums">
                Nota média: {dash.reviewAgg?.avg_rating ?? '5.0'}/5 ({dash.reviewAgg?.review_count || 0}) · Futuros:{' '}
                {dash.kpis?.upcoming_sessions || 0}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Tempo em chamada e comissão</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {formatDurationSeconds(dash.totalCallSeconds)}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1 font-mono tabular-nums">
                Sua parcela: {100 - Number(dash.professional.commission_percentage)}% (taxa{' '}
                {dash.professional.commission_percentage}%) · {dash.authorizedClientCount || 0} clientes
              </div>
            </div>
          </div>

          {/* Incoming / Active Calls */}
          {dash.incomingCalls?.length > 0 && (
            <div className="rounded-2xl border border-[#D4AF37]/40 bg-[#18181D] p-6 space-y-3">
              <h2 className="text-sm font-semibold text-[#E5C97B]">Chamadas autorizadas aguardando ingresso</h2>
              {dash.incomingCalls.map((c: Record<string, any>) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-white/10">
                  <div>
                    <div className="text-sm font-medium text-[#F5F2EB]">{c.client_name}</div>
                    <div className="text-xs text-zinc-400 font-mono tabular-nums">
                      Duração: {c.duration_minutes} min · {bookingStatusLabel(c.call_status).label} ·{' '}
                      {formatDateTime(c.scheduled_at)}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleCallAction(c.id, 'accept')}
                      className="px-4 py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] cursor-pointer"
                    >
                      Aceitar e entrar
                    </button>
                    {c.call_status === 'aguardando_profissional' && (
                      <button
                        type="button"
                        onClick={() => handleCallAction(c.id, 'decline')}
                        className="px-3 py-2 rounded-lg border border-white/15 text-xs text-zinc-300 hover:bg-white/5 cursor-pointer"
                      >
                        Recusar
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Chart with Period Toggle */}
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[#F5F2EB]">Evolução dos seus ganhos líquidos</div>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[#111115] border border-white/10">
                {[
                  { key: 'daily', label: 'Diário' },
                  { key: 'weekly', label: 'Semanal' },
                  { key: 'monthly', label: 'Mensal' },
                ].map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setDashPeriod(opt.key as 'daily' | 'weekly' | 'monthly')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                      dashPeriod === opt.key ? 'bg-[#D4AF37] text-[#09090B]' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <RevenueChart
              title="Receita líquida creditada"
              subtitle="Valores já descontados da taxa administrativa da plataforma"
              data={(dash.earningsSeries || []).map((p: Record<string, any>) => ({
                label: p.day,
                valueCents: Number(p.cents),
                secondaryValue: Number(p.sessions),
              }))}
            />
          </div>

          {/* Upcoming Bookings + Recent Reviews */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl border border-white/10 bg-[#111115] p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-[#F5F2EB]">Próximas sessões agendadas</h2>
                <Link to="/profissional/agenda" className="text-xs text-[#E5C97B] hover:underline">
                  Ver agenda completa
                </Link>
              </div>
              {dash.upcomingBookings?.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-500">Nenhum agendamento pendente no momento.</div>
              ) : (
                <div className="divide-y divide-white/10">
                  {(dash.upcomingBookings || []).map((b: Record<string, any>) => {
                    const st = bookingStatusLabel(b.status);
                    return (
                      <div key={b.id} className="py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-[#F5F2EB] truncate">{b.client_name}</div>
                          <div className="text-[11px] text-zinc-400 font-mono tabular-nums mt-0.5">
                            {formatDateTime(b.scheduled_at)} · {b.duration_minutes}m ·{' '}
                            <span className={st.colorClass}>{st.label}</span>
                          </div>
                        </div>
                        {b.video_call_id && b.status === 'pagamento_confirmado' && (
                          <button
                            type="button"
                            onClick={() => navigate(`/sala/${b.video_call_id}`)}
                            className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer shrink-0"
                          >
                            Abrir sala
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-white/10 bg-[#111115] p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-[#F5F2EB]">Avaliações recentes dos seus clientes</h2>
                <span className="text-xs font-mono tabular-nums text-[#E5C97B]">
                  {dash.reviewAgg?.avg_rating ?? '5.0'}/5 ({dash.reviewAgg?.review_count || 0})
                </span>
              </div>
              {dash.recentReviews?.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-500">Nenhuma avaliação publicada ainda.</div>
              ) : (
                <div className="divide-y divide-white/10">
                  {(dash.recentReviews || []).map((r: Record<string, any>) => (
                    <div key={r.id} className="py-3 space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-[#F5F2EB]">{r.client_name}</span>
                        <span className="inline-flex items-center gap-1 font-mono tabular-nums text-[#E5C97B]">
                          <Star className="w-3.5 h-3.5 fill-[#D4AF37] text-[#D4AF37]" />
                          {r.rating}/5
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400">{r.comment}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : section === 'profile' && dash ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <form onSubmit={handleSaveProfile} className="lg:col-span-7 rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-5">
            <div className="flex items-center gap-4 pb-4 border-b border-white/10">
              <ProfileAvatar src={profileImage} name={professionalName || dash.professional.professional_name} className="w-16 h-16" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[#F5F2EB] truncate">{professionalName}</div>
                <div className="text-xs text-zinc-400">
                  {dash.professional.category} · {dash.professional.email}
                </div>
                <Link
                  to={`/profissional/${dash.professional.slug}`}
                  className="inline-flex items-center gap-1 text-[11px] text-[#E5C97B] hover:underline mt-1"
                >
                  <span>Visualizar página pública</span>
                  <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Nome de exibição pública</label>
                <input
                  required
                  type="text"
                  value={professionalName}
                  onChange={(e) => setProfessionalName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Nome completo (conta privada)</label>
                <input
                  required
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Telefone de contato</label>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">URL da foto de perfil</label>
                <input
                  type="text"
                  placeholder="https://... ou /src/assets/..."
                  value={profileImage}
                  onChange={(e) => setProfileImage(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-300 mb-2">Idiomas de atendimento</label>
              <div className="flex flex-wrap gap-2">
                {LANGUAGE_OPTIONS.map((lang) => {
                  const selected = languages.includes(lang);
                  return (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => {
                        if (selected && languages.length === 1) return;
                        setLanguages(selected ? languages.filter((l) => l !== lang) : [...languages, lang]);
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs border transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#D4AF37]/15 border-[#D4AF37] text-[#E5C97B]'
                          : 'bg-[#09090B] border-white/10 text-zinc-400 hover:text-white'
                      }`}
                    >
                      {lang}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-300 mb-1.5">Biografia profissional</label>
              <textarea
                required
                minLength={10}
                rows={5}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              />
            </div>

            <label className="flex items-center gap-2.5 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={instantEnabled}
                onChange={(e) => setInstantEnabled(e.target.checked)}
                className="rounded border-white/20"
              />
              <span>Permitir solicitações de chamada imediata quando meu status estiver Online</span>
            </label>

            <button
              type="submit"
              className="px-5 py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] cursor-pointer"
            >
              Salvar alterações
            </button>
          </form>

          {/* Commercial Terms (Admin-governed, Read-only) + Reviews */}
          <div className="lg:col-span-5 space-y-6">
            <div className="rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F5F2EB]">
                <Lock className="w-4 h-4 text-[#D4AF37]" />
                <span>Condições comerciais da conta</span>
              </div>
              <p className="text-xs text-zinc-400">
                Valores, duração padrão e comissão são definidos pela administração da plataforma.
              </p>
              <div className="divide-y divide-white/10 text-xs">
                <div className="py-2.5 flex justify-between">
                  <span className="text-zinc-400">Valor por sessão ({dash.professional.session_duration} min)</span>
                  <span className="font-mono tabular-nums text-[#E5C97B]">
                    {formatBRL(dash.professional.price_per_session_cents)}
                  </span>
                </div>
                <div className="py-2.5 flex justify-between">
                  <span className="text-zinc-400">Valor por minuto</span>
                  <span className="font-mono tabular-nums text-zinc-200">
                    {formatBRL(dash.professional.price_per_minute_cents)}/min
                  </span>
                </div>
                <div className="py-2.5 flex justify-between">
                  <span className="text-zinc-400">Comissão da plataforma</span>
                  <span className="font-mono tabular-nums text-zinc-200">{dash.professional.commission_percentage}%</span>
                </div>
                <div className="py-2.5 flex justify-between">
                  <span className="text-zinc-400">Seu repasse líquido</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    {100 - Number(dash.professional.commission_percentage)}%
                  </span>
                </div>
                <div className="py-2.5 flex justify-between">
                  <span className="text-zinc-400">Status de catálogo</span>
                  <span className={dash.professional.is_approved ? 'text-emerald-400' : 'text-amber-400'}>
                    {dash.professional.is_approved ? 'Aprovado e visível' : 'Aguardando aprovação'}
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-3">
              <div className="text-sm font-semibold text-[#F5F2EB]">Avaliações publicadas ({proReviews.length})</div>
              {proReviews.length === 0 ? (
                <div className="text-xs text-zinc-500">Nenhuma avaliação registrada ainda.</div>
              ) : (
                <div className="divide-y divide-white/10 max-h-64 overflow-y-auto pr-1">
                  {proReviews.map((r) => (
                    <div key={r.id} className="py-2.5 space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="font-medium text-zinc-200">{r.client_name}</span>
                        <span className="font-mono tabular-nums text-[#E5C97B]">{r.rating}/5</span>
                      </div>
                      <p className="text-xs text-zinc-400">{r.comment}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : section === 'agenda' ? (
        <div className="space-y-6">
          <div className="flex items-center gap-1 p-1 rounded-lg bg-[#111115] border border-white/10 w-fit">
            <button
              type="button"
              onClick={() => setAgendaTab('bookings')}
              className={`px-4 py-2 rounded-md text-xs font-medium cursor-pointer ${
                agendaTab === 'bookings' ? 'bg-[#D4AF37] text-[#09090B]' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Sessões agendadas ({bookings.length})
            </button>
            <button
              type="button"
              onClick={() => setAgendaTab('availability')}
              className={`px-4 py-2 rounded-md text-xs font-medium cursor-pointer ${
                agendaTab === 'availability' ? 'bg-[#D4AF37] text-[#09090B]' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Horários semanais e bloqueios
            </button>
          </div>

          {agendaTab === 'bookings' ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-white/10 bg-[#111115] p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="relative sm:col-span-2">
                  <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Buscar por nome ou e-mail do cliente..."
                    value={bookingSearch}
                    onChange={(e) => setBookingSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
                  />
                </div>
                <select
                  value={bookingStatusFilter}
                  onChange={(e) => setBookingStatusFilter(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
                >
                  <option value="all">Todos os status</option>
                  <option value="pagamento_confirmado">Pagamento confirmado</option>
                  <option value="aguardando_pagamento">Aguardando pagamento</option>
                  <option value="em_andamento">Em andamento</option>
                  <option value="finalizada">Finalizada</option>
                  <option value="cancelada">Cancelada</option>
                </select>
              </div>

              <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
                {bookings.length === 0 ? (
                  <div className="p-8 text-center text-xs text-zinc-500">Nenhum agendamento localizado.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-white/10 text-zinc-400">
                        <tr>
                          <th className="py-3.5 px-5 font-medium">Cliente</th>
                          <th className="py-3.5 px-5 font-medium">Data e hora</th>
                          <th className="py-3.5 px-5 font-medium">Modalidade</th>
                          <th className="py-3.5 px-5 font-medium">Valor bruto</th>
                          <th className="py-3.5 px-5 font-medium">Status</th>
                          <th className="py-3.5 px-5 font-medium text-right">Ações</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {bookings.map((b) => {
                          const st = bookingStatusLabel(b.status);
                          const canEnter =
                            b.video_call_id && ['pagamento_confirmado', 'em_andamento'].includes(b.status);
                          const canCancel = !['finalizada', 'cancelada', 'expirou'].includes(b.status);
                          return (
                            <tr key={b.id}>
                              <td className="py-3.5 px-5">
                                <div className="font-medium text-[#F5F2EB]">{b.client_name}</div>
                                <div className="text-[11px] text-zinc-500">{b.client_email}</div>
                              </td>
                              <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                                {formatDateTime(b.scheduled_at)}
                              </td>
                              <td className="py-3.5 px-5 text-zinc-400">
                                {b.billing_mode === 'per_minute' ? 'Por minuto' : 'Sessão'} · {b.duration_minutes}m
                              </td>
                              <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                                {formatBRL(b.amount_cents)}
                              </td>
                              <td className={`py-3.5 px-5 font-medium ${st.colorClass}`}>{st.label}</td>
                              <td className="py-3.5 px-5 text-right space-x-2 whitespace-nowrap">
                                {canEnter && (
                                  <button
                                    type="button"
                                    onClick={() => navigate(`/sala/${b.video_call_id}`)}
                                    className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#09090B] font-semibold cursor-pointer"
                                  >
                                    Entrar na sala
                                  </button>
                                )}
                                {canCancel && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (!confirm(`Cancelar agendamento com ${b.client_name}?`)) return;
                                      runAction(async () => {
                                        await apiFetch(`/api/professional/bookings/${b.id}/cancel`, {
                                          method: 'POST',
                                          body: JSON.stringify({ reason: 'Indisponibilidade informada pelo profissional' }),
                                        });
                                      }, 'Agendamento cancelado e cliente notificado.');
                                    }}
                                    className="px-2.5 py-1.5 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 cursor-pointer"
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
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Recurring Weekly Slots */}
              <div className="lg:col-span-7 rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">Horários semanais recorrentes</h2>
                    <p className="text-xs text-zinc-400">Clientes só conseguem agendar dentro das janelas ativas.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setSlots([...slots, { day_of_week: 1, start_time: '09:00', end_time: '18:00', is_available: true }])
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/15 text-xs text-zinc-200 hover:bg-white/5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Adicionar janela</span>
                  </button>
                </div>

                {slots.length === 0 ? (
                  <div className="p-6 rounded-xl border border-white/10 bg-[#09090B] text-center text-xs text-zinc-500">
                    Nenhuma janela configurada. Adicione um horário semanal para receber agendamentos.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {slots.map((s, idx) => (
                      <div
                        key={idx}
                        className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center p-3 rounded-xl bg-[#09090B] border border-white/10"
                      >
                        <select
                          value={s.day_of_week}
                          onChange={(e) => {
                            const next = [...slots];
                            next[idx].day_of_week = Number(e.target.value);
                            setSlots(next);
                          }}
                          className="sm:col-span-4 px-3 py-2 rounded-lg bg-[#111115] border border-white/10 text-xs text-white"
                        >
                          {DAY_NAMES_PT.map((d, dIdx) => (
                            <option key={d} value={dIdx}>
                              {d}
                            </option>
                          ))}
                        </select>
                        <input
                          type="time"
                          value={s.start_time}
                          onChange={(e) => {
                            const next = [...slots];
                            next[idx].start_time = e.target.value;
                            setSlots(next);
                          }}
                          className="sm:col-span-3 px-3 py-2 rounded-lg bg-[#111115] border border-white/10 text-xs text-white font-mono"
                        />
                        <input
                          type="time"
                          value={s.end_time}
                          onChange={(e) => {
                            const next = [...slots];
                            next[idx].end_time = e.target.value;
                            setSlots(next);
                          }}
                          className="sm:col-span-3 px-3 py-2 rounded-lg bg-[#111115] border border-white/10 text-xs text-white font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => setSlots(slots.filter((_, i) => i !== idx))}
                          aria-label="Remover janela"
                          className="sm:col-span-2 text-xs text-red-400 hover:underline text-left sm:text-right cursor-pointer"
                        >
                          Remover
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleSaveAvailability}
                  className="px-5 py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] cursor-pointer"
                >
                  Salvar disponibilidade semanal
                </button>
              </div>

              {/* Date-specific Availability Blocks */}
              <div className="lg:col-span-5 rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-5 h-fit">
                <div>
                  <h2 className="text-base font-semibold">Bloqueios pontuais de agenda</h2>
                  <p className="text-xs text-zinc-400 mt-1">
                    Bloqueie feriados, viagens ou faixas de horário em uma data específica.
                  </p>
                </div>

                <form onSubmit={handleAddBlock} className="space-y-3 p-4 rounded-xl bg-[#09090B] border border-white/10">
                  <div>
                    <label className="block text-xs text-zinc-300 mb-1">Data do bloqueio</label>
                    <input
                      required
                      type="date"
                      value={newBlockDate}
                      onChange={(e) => setNewBlockDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[#111115] border border-white/15 text-xs text-white"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">Início (opcional)</label>
                      <input
                        type="time"
                        value={newBlockStart}
                        onChange={(e) => setNewBlockStart(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-[#111115] border border-white/15 text-xs text-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">Fim (opcional)</label>
                      <input
                        type="time"
                        value={newBlockEnd}
                        onChange={(e) => setNewBlockEnd(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-[#111115] border border-white/15 text-xs text-white font-mono"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Motivo</label>
                    <input
                      type="text"
                      placeholder="Ex: Compromisso externo ou feriado"
                      value={newBlockReason}
                      onChange={(e) => setNewBlockReason(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[#111115] border border-white/15 text-xs text-white"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
                  >
                    Bloquear data / horário
                  </button>
                </form>

                {blocks.length === 0 ? (
                  <div className="text-xs text-zinc-500 text-center py-2">Nenhum bloqueio pontual cadastrado.</div>
                ) : (
                  <div className="divide-y divide-white/10">
                    {blocks.map((bl) => (
                      <div key={bl.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div>
                          <div className="font-mono tabular-nums text-[#F5F2EB]">
                            {bl.block_date}{' '}
                            {bl.start_time ? `· ${bl.start_time} às ${bl.end_time}` : '· Dia inteiro'}
                          </div>
                          {bl.reason && <div className="text-[11px] text-zinc-400">{bl.reason}</div>}
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            runAction(async () => {
                              await apiFetch(`/api/professional/availability/blocks/${bl.id}`, { method: 'DELETE' });
                            }, 'Bloqueio removido.')
                          }
                          aria-label="Remover bloqueio"
                          className="p-1.5 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : section === 'calls' ? (
        <div className="space-y-6">
          {callSummary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="rounded-xl border border-white/10 bg-[#111115] p-4">
                <div className="text-[11px] text-zinc-400">Total de chamadas</div>
                <div className="text-xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                  {callSummary.total_calls || 0}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-[#111115] p-4">
                <div className="text-[11px] text-zinc-400">Concluídas</div>
                <div className="text-xl font-semibold font-mono tabular-nums text-emerald-400 mt-1">
                  {callSummary.completed_calls || 0}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-[#111115] p-4">
                <div className="text-[11px] text-zinc-400">Tempo acumulado</div>
                <div className="text-xl font-semibold font-mono tabular-nums text-[#E5C97B] mt-1">
                  {formatDurationSeconds(callSummary.total_seconds)}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-[#111115] p-4">
                <div className="text-[11px] text-zinc-400">Duração média</div>
                <div className="text-xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                  {formatDurationSeconds(callSummary.avg_duration_seconds)}
                </div>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-white/10 bg-[#111115] p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="relative sm:col-span-2">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar por cliente ou código da sala..."
                value={callSearch}
                onChange={(e) => setCallSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
              />
            </div>
            <select
              value={callStatusFilter}
              onChange={(e) => setCallStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="all">Todos os status</option>
              <option value="pagamento_confirmado">Pagamento confirmado</option>
              <option value="aguardando_profissional">Aguardando profissional</option>
              <option value="em_andamento">Em andamento</option>
              <option value="finalizada">Finalizada</option>
              <option value="cancelada">Cancelada</option>
              <option value="recusada">Recusada</option>
            </select>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            {calls.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">Nenhuma videochamada registrada neste filtro.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/10 text-zinc-400">
                    <tr>
                      <th className="py-3.5 px-5 font-medium">Cliente</th>
                      <th className="py-3.5 px-5 font-medium">Agendado / Tipo</th>
                      <th className="py-3.5 px-5 font-medium">Duração real</th>
                      <th className="py-3.5 px-5 font-medium">Valor bruto</th>
                      <th className="py-3.5 px-5 font-medium">Status</th>
                      <th className="py-3.5 px-5 font-medium text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {calls.map((c) => {
                      const st = bookingStatusLabel(c.call_status);
                      const canEnter = [
                        'pagamento_confirmado',
                        'aguardando_profissional',
                        'aguardando_cliente',
                        'em_andamento',
                      ].includes(c.call_status);
                      return (
                        <tr key={c.id}>
                          <td className="py-3.5 px-5">
                            <div className="font-medium text-[#F5F2EB]">{c.client_name}</div>
                            <div className="text-[11px] font-mono text-zinc-500">{c.room_name}</div>
                          </td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                            {formatDateTime(c.scheduled_at)}
                            <div className="text-[11px] font-sans text-zinc-500">
                              {c.is_instant ? 'Chamada imediata' : 'Sessão agendada'}
                            </div>
                          </td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                            {formatDurationSeconds(c.duration_seconds)} ({c.duration_minutes}m contratados)
                          </td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                            {formatBRL(c.amount_cents)}
                          </td>
                          <td className={`py-3.5 px-5 font-medium ${st.colorClass}`}>{st.label}</td>
                          <td className="py-3.5 px-5 text-right space-x-2 whitespace-nowrap">
                            {c.call_status === 'aguardando_profissional' ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleCallAction(c.id, 'accept')}
                                  className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#09090B] font-semibold cursor-pointer"
                                >
                                  Aceitar e entrar
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleCallAction(c.id, 'decline')}
                                  className="px-2.5 py-1.5 rounded border border-white/15 text-zinc-300 cursor-pointer"
                                >
                                  Recusar
                                </button>
                              </>
                            ) : canEnter ? (
                              <button
                                type="button"
                                onClick={() => navigate(`/sala/${c.id}`)}
                                className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#09090B] font-semibold cursor-pointer"
                              >
                                Entrar na sala
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : section === 'clients' ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-[#111115] p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar entre os clientes que já contrataram com você..."
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
              />
            </div>
            <div className="text-xs text-zinc-400">
              Isolamento ativo: exibindo apenas clientes com vínculo autorizado na sua agenda.
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] divide-y divide-white/10">
            {clients.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-400">Nenhum cliente atendido ainda.</div>
            ) : (
              clients.map((cl) => (
                <div key={cl.client_id} className="p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-[#F5F2EB]">{cl.full_name}</div>
                      <div className="text-xs text-zinc-400 font-mono tabular-nums mt-0.5">
                        {cl.email} · {cl.completed_sessions || 0}/{cl.total_sessions} sessões · Total com você:{' '}
                        {formatBRL(cl.total_spent_cents)} · Última: {formatDateTime(cl.last_session_at)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleClientHistory(cl.client_id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 text-xs text-zinc-200 hover:bg-white/5 cursor-pointer"
                      >
                        <History className="w-3.5 h-3.5" />
                        <span>{expandedHistoryClientId === cl.client_id ? 'Ocultar histórico' : 'Histórico comigo'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingNoteClientId(cl.client_id);
                          setNoteDraft(cl.private_notes || '');
                        }}
                        className="px-3 py-1.5 rounded-lg border border-[#D4AF37]/40 text-xs text-[#E5C97B] hover:bg-[#D4AF37]/10 cursor-pointer"
                      >
                        Observações privadas
                      </button>
                    </div>
                  </div>

                  {cl.private_notes && editingNoteClientId !== cl.client_id && (
                    <div className="p-3 rounded-lg bg-[#09090B] border border-white/5 text-xs text-zinc-300">
                      <span className="text-zinc-500">Nota privada: </span>
                      {cl.private_notes}
                    </div>
                  )}

                  {expandedHistoryClientId === cl.client_id && (
                    <div className="p-4 rounded-xl bg-[#09090B] border border-white/10 space-y-2">
                      <div className="text-xs font-semibold text-[#E5C97B]">
                        Atendimentos autorizados entre você e {cl.full_name}
                      </div>
                      {historyLoading ? (
                        <div className="text-xs text-zinc-500">Carregando histórico...</div>
                      ) : clientHistory.length === 0 ? (
                        <div className="text-xs text-zinc-500">Sem sessões registradas.</div>
                      ) : (
                        <div className="divide-y divide-white/5">
                          {clientHistory.map((s) => {
                            const st = bookingStatusLabel(s.status);
                            return (
                              <div key={s.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                                <div className="font-mono tabular-nums text-zinc-300">
                                  {formatDateTime(s.scheduled_at)} · {s.duration_minutes}m ·{' '}
                                  <span className={st.colorClass}>{st.label}</span>
                                </div>
                                <div className="font-mono tabular-nums text-[#E5C97B]">
                                  {formatBRL(s.amount_cents)}
                                  {s.duration_seconds ? ` · real ${formatDurationSeconds(s.duration_seconds)}` : ''}
                                  {s.rating ? ` · nota ${s.rating}/5` : ''}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {editingNoteClientId === cl.client_id && (
                    <div className="space-y-2 pt-2">
                      <textarea
                        rows={3}
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        placeholder="Anotações confidenciais (visíveis apenas a você)..."
                        className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            runAction(async () => {
                              await apiFetch(`/api/professional/clients/${cl.client_id}/notes`, {
                                method: 'PUT',
                                body: JSON.stringify({ notes: noteDraft }),
                              });
                              setEditingNoteClientId(null);
                            }, 'Nota privada salva.')
                          }
                          className="px-4 py-1.5 rounded bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
                        >
                          Salvar nota
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingNoteClientId(null)}
                          className="px-3 py-1.5 text-xs text-zinc-400 cursor-pointer"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      ) : section === 'financials' && financials ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Saldo disponível para saque</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#E5C97B] mt-1">
                {formatBRL(financials.balance?.available_cents)}
              </div>
              <Link to="/profissional/saques" className="text-[11px] text-[#E5C97B] hover:underline mt-1 inline-block">
                Solicitar saque →
              </Link>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Saldo pendente (em andamento)</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-amber-400 mt-1">
                {formatBRL(financials.balance?.pending_cents)}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">Liberado ao finalizar a chamada</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Total já repassado</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-emerald-400 mt-1">
                {formatBRL(financials.balance?.paid_cents)}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1 font-mono tabular-nums">
                Saques concluídos
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Percent className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>Sua regra de comissão</span>
              </div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {financials.proNetPercentage}% líquido
              </div>
              <div className="text-[11px] text-zinc-500 mt-1 font-mono tabular-nums">
                Taxa plataforma: {financials.commissionPercentage}%
              </div>
            </div>
          </div>

          {/* Accumulated Totals */}
          <div className="rounded-xl border border-white/10 bg-[#111115] p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <div className="text-[11px] text-zinc-400">Faturamento bruto acumulado</div>
              <div className="text-base font-semibold font-mono tabular-nums text-zinc-200 mt-1">
                {formatBRL(financials.summary?.total_gross_cents)}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Comissão retida pela plataforma</div>
              <div className="text-base font-semibold font-mono tabular-nums text-zinc-400 mt-1">
                {formatBRL(financials.summary?.total_platform_fee_cents)}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Ganhos líquidos gerados</div>
              <div className="text-base font-semibold font-mono tabular-nums text-[#E5C97B] mt-1">
                {formatBRL(financials.summary?.total_net_cents)}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Estornos / Ajustes</div>
              <div className="text-base font-semibold font-mono tabular-nums text-zinc-300 mt-1">
                -{formatBRL(financials.summary?.total_refunded_cents)} / {formatBRL(financials.summary?.total_adjustments_cents)}
              </div>
            </div>
          </div>

          {/* Ledger Filter Bar */}
          <div className="rounded-xl border border-white/10 bg-[#111115] p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <select
              value={txTypeFilter}
              onChange={(e) => setTxTypeFilter(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="all">Todos os lançamentos</option>
              <option value="session_credit">Créditos de sessão</option>
              <option value="payout_debit">Repasses efetuados</option>
              <option value="refund_debit">Estornos</option>
              <option value="adjustment">Ajustes administrativos</option>
            </select>
            <input
              type="date"
              value={txFrom}
              onChange={(e) => setTxFrom(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
            />
            <input
              type="date"
              value={txTo}
              onChange={(e) => setTxTo(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
            />
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            {financials.transactions.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">Nenhuma movimentação encontrada para este filtro.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/10 text-zinc-400">
                    <tr>
                      <th className="py-3.5 px-5 font-medium">Data</th>
                      <th className="py-3.5 px-5 font-medium">Tipo</th>
                      <th className="py-3.5 px-5 font-medium">Cliente</th>
                      <th className="py-3.5 px-5 font-medium">Valor bruto</th>
                      <th className="py-3.5 px-5 font-medium">Taxa plataforma</th>
                      <th className="py-3.5 px-5 font-medium">Seu valor líquido</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {financials.transactions.map((t: Record<string, any>) => {
                      const txInfo = transactionTypeLabel(t.transaction_type);
                      return (
                        <tr key={t.id}>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">
                            {formatDateTime(t.created_at)}
                          </td>
                          <td className={`py-3.5 px-5 font-medium ${txInfo.colorClass}`}>{txInfo.label}</td>
                          <td className="py-3.5 px-5 text-zinc-300">{t.client_name || '—'}</td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                            {formatBRL(t.gross_cents)}
                          </td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">
                            {formatBRL(t.platform_fee_cents)}
                          </td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                            {formatBRL(t.professional_cents)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : section === 'payouts' && financials ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <form onSubmit={handleRequestPayout} className="lg:col-span-5 rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-4 h-fit">
            <div>
              <h2 className="text-base font-semibold">Solicitar saque de repasse</h2>
              <p className="text-xs text-zinc-400 mt-1 font-mono tabular-nums">
                Saldo disponível: <span className="text-[#E5C97B]">{formatBRL(financials.balance?.available_cents)}</span> ·
                Mínimo: {formatBRL(financials.minimumPayoutCents ?? 10000)}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {[
                { key: 'pix', label: 'PIX' },
                { key: 'ted', label: 'Transferência TED' },
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setPayoutMethod(m.key as 'pix' | 'ted')}
                  className={`py-2 px-3 rounded-lg text-xs font-medium border cursor-pointer ${
                    payoutMethod === m.key
                      ? 'bg-[#D4AF37]/15 border-[#D4AF37] text-[#E5C97B]'
                      : 'bg-[#09090B] border-white/10 text-zinc-400'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div>
              <label className="block text-xs text-zinc-300 mb-1.5">Valor em R$</label>
              <input
                required
                type="number"
                min={Math.max(10, Math.round(Number(financials.minimumPayoutCents ?? 10000) / 100))}
                step="0.01"
                value={payoutBRL}
                onChange={(e) => setPayoutBRL(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white font-mono"
              />
            </div>

            {payoutMethod === 'pix' ? (
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Chave PIX de destino</label>
                <input
                  required
                  type="text"
                  placeholder="CPF, CNPJ, e-mail, telefone ou chave aleatória"
                  value={pixKey}
                  onChange={(e) => setPixKey(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            ) : (
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Dados bancários para TED</label>
                <textarea
                  required
                  rows={3}
                  placeholder="Banco, agência, conta corrente/poupança e CPF/CNPJ do titular"
                  value={tedDetails}
                  onChange={(e) => setTedDetails(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={Number(financials.balance?.available_cents || 0) < Number(financials.minimumPayoutCents || 10000)}
              className="w-full py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] disabled:opacity-40 cursor-pointer"
            >
              Enviar solicitação de saque
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            {financials.payouts.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">Nenhuma solicitação de saque realizada ainda.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/10 text-zinc-400">
                    <tr>
                      <th className="py-3.5 px-5 font-medium">Solicitado em</th>
                      <th className="py-3.5 px-5 font-medium">Destino</th>
                      <th className="py-3.5 px-5 font-medium">Valor</th>
                      <th className="py-3.5 px-5 font-medium">Status / Observações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {financials.payouts.map((po: Record<string, any>) => {
                      const st = bookingStatusLabel(po.status);
                      return (
                        <tr key={po.id}>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">
                            {formatDateTime(po.requested_at)}
                            {po.paid_at && (
                              <div className="text-[11px] text-emerald-400">Pago em {formatDateTime(po.paid_at)}</div>
                            )}
                          </td>
                          <td className="py-3.5 px-5 font-mono text-zinc-300">
                            {formatPayoutDetails(po.payout_details)}
                          </td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                            {formatBRL(po.amount_cents)}
                          </td>
                          <td className="py-3.5 px-5">
                            <div className={`font-medium ${st.colorClass}`}>{st.label}</div>
                            {po.admin_notes && <div className="text-[11px] text-zinc-400 mt-0.5">{po.admin_notes}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 rounded-lg bg-[#111115] border border-white/10">
              {[
                { key: 'all', label: 'Todas' },
                { key: 'unread', label: 'Não lidas' },
              ].map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setNotifFilter(t.key as 'all' | 'unread')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                    notifFilter === t.key ? 'bg-[#D4AF37] text-[#09090B]' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {notifications.some((n) => !n.read_at) && (
              <button
                type="button"
                onClick={() =>
                  runAction(async () => {
                    await apiFetch('/api/professional/notifications/read-all', { method: 'POST' });
                  }, 'Todas as notificações foram marcadas como lidas.')
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 text-xs text-zinc-200 hover:bg-white/5 cursor-pointer"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>Marcar todas como lidas</span>
              </button>
            )}
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] divide-y divide-white/10">
            {visibleNotifications.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-400">Sem notificações nesta visualização.</div>
            ) : (
              visibleNotifications.map((n) => (
                <div key={n.id} className="p-5 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-[#F5F2EB]">{n.title}</div>
                    <div className="text-xs text-zinc-400 mt-1">{n.message}</div>
                    <div className="text-[11px] font-mono tabular-nums text-zinc-500 mt-1 inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>{formatDateTime(n.created_at)}</span>
                    </div>
                  </div>
                  {!n.read_at && (
                    <button
                      type="button"
                      onClick={() =>
                        runAction(async () => {
                          await apiFetch(`/api/professional/notifications/${n.id}/read`, { method: 'POST' });
                        })
                      }
                      className="text-xs text-[#E5C97B] hover:underline cursor-pointer shrink-0"
                    >
                      Marcar lida
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
