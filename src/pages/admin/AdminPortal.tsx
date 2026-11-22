import React, { useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  Calendar,
  CheckCircle2,
  CreditCard,
  DollarSign,
  Download,
  Edit3,
  FileSpreadsheet,
  Globe,
  KeyRound,
  LayoutDashboard,
  Percent,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  UserCheck,
  Users,
  Video,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch, exportToCsv } from '../../lib/api';
import {
  availabilityLabel,
  bookingStatusLabel,
  formatBRL,
  formatDateTime,
  formatDurationSeconds,
  formatMoney,
  gatewayLabel,
} from '../../lib/format';
import { DashboardShell, type SidebarItem } from '../../components/ui/DashboardShell';
import { RevenueChart } from '../../components/ui/RevenueChart';

const ADMIN_SIDEBAR: SidebarItem[] = [
  { to: '/admin/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  { to: '/admin/profissionais', label: 'Profissionais', icon: <UserCheck className="w-4 h-4" /> },
  { to: '/admin/clientes', label: 'Clientes', icon: <Users className="w-4 h-4" /> },
  { to: '/admin/agendamentos', label: 'Agendamentos', icon: <Calendar className="w-4 h-4" /> },
  { to: '/admin/chamadas', label: 'Videochamadas', icon: <Video className="w-4 h-4" /> },
  { to: '/admin/pagamentos', label: 'Pagamentos', icon: <CreditCard className="w-4 h-4" /> },
  { to: '/admin/gateways', label: 'Gateways de Pagamento', icon: <Globe className="w-4 h-4" /> },
  { to: '/admin/comissoes', label: 'Comissões', icon: <Percent className="w-4 h-4" /> },
  { to: '/admin/financeiro', label: 'Ledger Financeiro', icon: <DollarSign className="w-4 h-4" /> },
  { to: '/admin/saques', label: 'Repasses e Saques', icon: <Wallet className="w-4 h-4" /> },
  { to: '/admin/cupons', label: 'Cupons', icon: <Tag className="w-4 h-4" /> },
  { to: '/admin/avaliacoes', label: 'Avaliações', icon: <Star className="w-4 h-4" /> },
  { to: '/admin/relatorios', label: 'Relatórios e CSV', icon: <FileSpreadsheet className="w-4 h-4" /> },
  { to: '/admin/notificacoes', label: 'Notificações', icon: <Bell className="w-4 h-4" /> },
  { to: '/admin/configuracoes', label: 'Configurações', icon: <Settings className="w-4 h-4" /> },
  { to: '/admin/auditoria', label: 'Auditoria', icon: <Activity className="w-4 h-4" /> },
];

export type AdminSection =
  | 'dashboard'
  | 'professionals'
  | 'clients'
  | 'bookings'
  | 'calls'
  | 'payments'
  | 'gateways'
  | 'commissions'
  | 'financials'
  | 'payouts'
  | 'coupons'
  | 'reviews'
  | 'reports'
  | 'notifications'
  | 'settings'
  | 'audit';

export function AdminPortal({ section }: { section: AdminSection }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Dashboard
  const [dashPeriod, setDashPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [dash, setDash] = useState<Record<string, any> | null>(null);

  // Lists
  const [pros, setPros] = useState<Array<Record<string, any>>>([]);
  const [clients, setClients] = useState<Array<Record<string, any>>>([]);
  const [bookings, setBookings] = useState<Array<Record<string, any>>>([]);
  const [calls, setCalls] = useState<Array<Record<string, any>>>([]);
  const [payments, setPayments] = useState<Array<Record<string, any>>>([]);
  const [transactions, setTransactions] = useState<Array<Record<string, any>>>([]);
  const [webhookEvents, setWebhookEvents] = useState<Array<Record<string, any>>>([]);
  const [gatewayStatus, setGatewayStatus] = useState<{
    configured: boolean;
    environment: string;
    isTestMode: boolean;
    webhookSecretConfigured: boolean;
    mercadopagoEnabled?: boolean;
    paypalEnabled?: boolean;
  } | null>(null);
  const [gatewaysList, setGatewaysList] = useState<Array<Record<string, any>>>([]);
  const [gatewayDrafts, setGatewayDrafts] = useState<Record<string, Record<string, any>>>({});
  const [gatewayCredInputs, setGatewayCredInputs] = useState<Record<string, Record<string, string>>>({});
  const [gatewayTestResults, setGatewayTestResults] = useState<Record<string, { ok: boolean; status: string; message: string }>>({});
  const [confirmRefundId, setConfirmRefundId] = useState<string | null>(null);
  const [refundReason, setRefundReason] = useState('Estorno solicitado pela administração');
  const [payoutRefEdits, setPayoutRefEdits] = useState<Record<string, string>>({});
  const [payoutsData, setPayoutsData] = useState<{
    payouts: Array<Record<string, any>>;
    summary: { pending_cents: number; approved_cents: number; paid_cents: number };
  } | null>(null);
  const [coupons, setCoupons] = useState<Array<Record<string, any>>>([]);
  const [reviews, setReviews] = useState<Array<Record<string, any>>>([]);
  const [adminNotifications, setAdminNotifications] = useState<Array<Record<string, any>>>([]);
  const [auditLogs, setAuditLogs] = useState<Array<Record<string, any>>>([]);

  // Reports
  const [reportsData, setReportsData] = useState<{
    rows: Array<Record<string, any>>;
    summary: Record<string, number>;
    proOptions: Array<{ id: string; professional_name: string }>;
    clientOptions: Array<{ id: string; full_name: string }>;
  } | null>(null);
  const [reportFilters, setReportFilters] = useState({
    professionalId: '',
    clientId: '',
    status: '',
    billingMode: '',
    paymentStatus: '',
    from: '',
    to: '',
  });

  // Search & Filters
  const [proSearch, setProSearch] = useState('');
  const [proApprovalFilter, setProApprovalFilter] = useState('all');
  const [proAvailFilter, setProAvailFilter] = useState('all');

  const [clientSearch, setClientSearch] = useState('');
  const [clientStatusFilter, setClientStatusFilter] = useState('all');

  const [bookingSearch, setBookingSearch] = useState('');
  const [bookingStatusFilter, setBookingStatusFilter] = useState('all');

  const [callSearch, setCallSearch] = useState('');
  const [callStatusFilter, setCallStatusFilter] = useState('all');

  const [paymentSearch, setPaymentSearch] = useState('');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('all');
  const [paymentGatewayFilter, setPaymentGatewayFilter] = useState('all');

  const [payoutStatusFilter, setPayoutStatusFilter] = useState('all');
  const [auditSearch, setAuditSearch] = useState('');

  // Settings & Supabase Test
  const [settingsData, setSettingsData] = useState<{
    settings: Record<string, any>;
    integrations: Record<string, boolean | string>;
  } | null>(null);
  const [supabaseVerifyResult, setSupabaseVerifyResult] = useState<{ connected: boolean; message: string } | null>(null);

  // Modals: Create & Edit Professional
  const [showCreatePro, setShowCreatePro] = useState(false);
  const [newPro, setNewPro] = useState({
    fullName: '',
    professionalName: '',
    email: '',
    password: '',
    phone: '',
    category: 'Estratégia Executiva',
    priceSessionBRL: '350',
    priceMinuteBRL: '15',
    sessionDuration: '30',
    commissionPercentage: '30',
    bio: '',
  });

  const [editingPro, setEditingPro] = useState<Record<string, any> | null>(null);
  const [editingClient, setEditingClient] = useState<Record<string, any> | null>(null);

  // Commissions inline edit
  const [commissionEdits, setCommissionEdits] = useState<Record<string, string>>({});

  // Manual Ledger Adjustment
  const [adjProId, setAdjProId] = useState('');
  const [adjAmountBRL, setAdjAmountBRL] = useState('');
  const [adjReason, setAdjReason] = useState('');

  // New Coupon
  const [newCouponCode, setNewCouponCode] = useState('');
  const [newCouponType, setNewCouponType] = useState<'percentage' | 'fixed_cents'>('percentage');
  const [newCouponValue, setNewCouponValue] = useState('15');
  const [newCouponLimit, setNewCouponLimit] = useState('100');

  // Broadcast Notification
  const [broadcastAudience, setBroadcastAudience] = useState<'all' | 'professionals' | 'clients'>('all');
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastMsg, setBroadcastMsg] = useState('');

  async function loadSection() {
    setLoading(true);
    setError('');
    try {
      if (section === 'dashboard') {
        const res = await apiFetch<Record<string, any>>(`/api/admin/dashboard?period=${dashPeriod}`);
        setDash(res);
      } else if (section === 'professionals' || section === 'commissions') {
        const params = new URLSearchParams();
        if (proSearch.trim()) params.set('search', proSearch.trim());
        if (proApprovalFilter !== 'all') params.set('approval', proApprovalFilter);
        if (proAvailFilter !== 'all') params.set('availability', proAvailFilter);
        const res = await apiFetch<{ professionals: Array<Record<string, any>> }>(
          `/api/admin/professionals?${params.toString()}`
        );
        setPros(res.professionals);
        const map: Record<string, string> = {};
        for (const p of res.professionals) map[p.id] = String(p.commission_percentage);
        setCommissionEdits(map);
      } else if (section === 'clients') {
        const params = new URLSearchParams();
        if (clientSearch.trim()) params.set('search', clientSearch.trim());
        if (clientStatusFilter !== 'all') params.set('status', clientStatusFilter);
        const res = await apiFetch<{ clients: Array<Record<string, any>> }>(`/api/admin/clients?${params.toString()}`);
        setClients(res.clients);
      } else if (section === 'bookings') {
        const params = new URLSearchParams();
        if (bookingSearch.trim()) params.set('search', bookingSearch.trim());
        if (bookingStatusFilter !== 'all') params.set('status', bookingStatusFilter);
        const res = await apiFetch<{ bookings: Array<Record<string, any>> }>(`/api/admin/bookings?${params.toString()}`);
        setBookings(res.bookings);
      } else if (section === 'calls') {
        const params = new URLSearchParams();
        if (callSearch.trim()) params.set('search', callSearch.trim());
        if (callStatusFilter !== 'all') params.set('status', callStatusFilter);
        const res = await apiFetch<{ calls: Array<Record<string, any>> }>(`/api/admin/calls?${params.toString()}`);
        setCalls(res.calls);
      } else if (section === 'payments' || section === 'financials') {
        const params = new URLSearchParams();
        if (paymentSearch.trim()) params.set('search', paymentSearch.trim());
        if (paymentStatusFilter !== 'all') params.set('status', paymentStatusFilter);
        if (paymentGatewayFilter !== 'all') params.set('gateway', paymentGatewayFilter);
        const [payRes, proRes] = await Promise.all([
          apiFetch<{
            payments: Array<Record<string, any>>;
            transactions: Array<Record<string, any>>;
            webhookEvents?: Array<Record<string, any>>;
            gatewayStatus?: NonNullable<typeof gatewayStatus>;
          }>(`/api/admin/payments?${params.toString()}`),
          apiFetch<{ professionals: Array<Record<string, any>> }>('/api/admin/professionals'),
        ]);
        setPayments(payRes.payments);
        setTransactions(payRes.transactions);
        setWebhookEvents(payRes.webhookEvents || []);
        if (payRes.gatewayStatus) setGatewayStatus(payRes.gatewayStatus);
        setPros(proRes.professionals);
        if (!adjProId && proRes.professionals[0]) setAdjProId(proRes.professionals[0].id);
      } else if (section === 'gateways') {
        const res = await apiFetch<{
          gateways: Array<Record<string, any>>;
          webhookEvents: Array<Record<string, any>>;
        }>('/api/admin/gateways');
        setGatewaysList(res.gateways);
        setWebhookEvents(res.webhookEvents || []);
        const drafts: Record<string, Record<string, any>> = {};
        for (const gw of res.gateways) {
          drafts[gw.id] = {
            isEnabled: Boolean(gw.isEnabled),
            environment: gw.environment || 'sandbox',
            splitEnabled: Boolean(gw.splitEnabled),
            complianceVerified: Boolean(gw.complianceVerified),
            complianceNotes: String(gw.complianceNotes || ''),
          };
        }
        setGatewayDrafts(drafts);
      } else if (section === 'payouts') {
        const q = payoutStatusFilter !== 'all' ? `?status=${payoutStatusFilter}` : '';
        const res = await apiFetch<NonNullable<typeof payoutsData>>(`/api/admin/payouts${q}`);
        setPayoutsData(res);
      } else if (section === 'coupons') {
        const res = await apiFetch<{ coupons: Array<Record<string, any>> }>('/api/admin/coupons');
        setCoupons(res.coupons);
      } else if (section === 'reviews') {
        const res = await apiFetch<{ reviews: Array<Record<string, any>> }>('/api/admin/reviews');
        setReviews(res.reviews);
      } else if (section === 'reports') {
        const params = new URLSearchParams();
        Object.entries(reportFilters).forEach(([k, v]) => {
          if (v) params.set(k, v);
        });
        const res = await apiFetch<NonNullable<typeof reportsData>>(`/api/admin/reports?${params.toString()}`);
        setReportsData(res);
      } else if (section === 'notifications') {
        const res = await apiFetch<{ notifications: Array<Record<string, any>> }>('/api/admin/notifications');
        setAdminNotifications(res.notifications);
      } else if (section === 'settings') {
        const res = await apiFetch<{ settings: Record<string, any>; integrations: Record<string, boolean> }>(
          '/api/admin/settings'
        );
        setSettingsData(res);
      } else if (section === 'audit') {
        const q = auditSearch.trim() ? `?search=${encodeURIComponent(auditSearch.trim())}` : '';
        const res = await apiFetch<{ logs: Array<Record<string, any>> }>(`/api/admin/audit-logs${q}`);
        setAuditLogs(res.logs);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar dados administrativos.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSection();
  }, [
    section,
    dashPeriod,
    proSearch,
    proApprovalFilter,
    proAvailFilter,
    clientSearch,
    clientStatusFilter,
    bookingSearch,
    bookingStatusFilter,
    callSearch,
    callStatusFilter,
    paymentSearch,
    paymentStatusFilter,
    paymentGatewayFilter,
    payoutStatusFilter,
    auditSearch,
    reportFilters,
  ]);

  function flashNotice(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(''), 3500);
  }

  async function runAction(action: () => Promise<void>, successMessage?: string) {
    setError('');
    try {
      await action();
      if (successMessage) flashNotice(successMessage);
      loadSection();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao executar ação administrativa.');
    }
  }

  async function handleCreateProfessional(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await apiFetch('/api/admin/professionals', {
        method: 'POST',
        body: JSON.stringify({
          fullName: newPro.fullName,
          professionalName: newPro.professionalName,
          email: newPro.email,
          password: newPro.password,
          phone: newPro.phone,
          category: newPro.category,
          bio: newPro.bio,
          pricePerSessionCents: Math.round(Number(newPro.priceSessionBRL) * 100),
          pricePerMinuteCents: Math.round(Number(newPro.priceMinuteBRL) * 100),
          sessionDuration: Number(newPro.sessionDuration),
          commissionPercentage: Number(newPro.commissionPercentage),
          isApproved: true,
        }),
      });
      setShowCreatePro(false);
      setNewPro({
        fullName: '',
        professionalName: '',
        email: '',
        password: '',
        phone: '',
        category: 'Estratégia Executiva',
        priceSessionBRL: '350',
        priceMinuteBRL: '15',
        sessionDuration: '30',
        commissionPercentage: '30',
        bio: '',
      });
      flashNotice('Profissional cadastrado e aprovado com sucesso.');
      loadSection();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao cadastrar profissional.');
    }
  }

  async function handleSaveProEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingPro) return;
    setError('');
    try {
      await apiFetch(`/api/admin/professionals/${editingPro.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: editingPro.full_name,
          phone: editingPro.phone || '',
          professionalName: editingPro.professional_name,
          category: editingPro.category,
          bio: editingPro.bio,
          pricePerSessionCents: Math.round(Number(editingPro._priceSessionBRL) * 100),
          pricePerMinuteCents: Math.round(Number(editingPro._priceMinuteBRL) * 100),
          sessionDuration: Number(editingPro.session_duration),
          commissionPercentage: Number(editingPro.commission_percentage),
          isApproved: Boolean(editingPro.is_approved),
          isFeatured: Boolean(editingPro.is_featured),
          instantCallEnabled: Boolean(editingPro.instant_call_enabled),
          accountStatus: editingPro.account_status,
          availabilityStatus: editingPro.availability_status,
        }),
      });
      setEditingPro(null);
      flashNotice('Dados do profissional atualizados.');
      loadSection();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao atualizar profissional.');
    }
  }

  async function handleSaveClientEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingClient) return;
    await runAction(async () => {
      await apiFetch(`/api/admin/clients/${editingClient.user_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: editingClient.full_name,
          phone: editingClient.phone || '',
          status: editingClient.status,
        }),
      });
      setEditingClient(null);
    }, 'Dados do cliente atualizados.');
  }

  async function handleClearDemo() {
    if (!confirm('Remover permanentemente todos os usuários, agendamentos e registros financeiros marcados como Demo?')) {
      return;
    }
    await runAction(async () => {
      await apiFetch('/api/admin/demo/clear', { method: 'POST' });
    }, 'Dados de demonstração removidos com segurança.');
  }

  const titles: Record<AdminSection, string> = {
    dashboard: 'Dashboard Executivo',
    professionals: 'Gestão de Profissionais',
    clients: 'Gestão de Clientes',
    bookings: 'Agendamentos',
    calls: 'Monitoramento de Videochamadas',
    payments: 'Pagamentos e Estornos',
    gateways: 'Gateways de Pagamento',
    commissions: 'Gestão de Comissões',
    financials: 'Ledger Financeiro Imutável',
    payouts: 'Repasses e Solicitações de Saque',
    coupons: 'Cupons Promocionais',
    reviews: 'Moderação de Avaliações',
    reports: 'Relatórios Financeiros',
    notifications: 'Notificações Administrativas',
    settings: 'Configurações e Integrações',
    audit: 'Logs de Auditoria',
  };

  return (
    <DashboardShell
      title={titles[section]}
      breadcrumb={`Administração / ${titles[section]}`}
      items={ADMIN_SIDEBAR}
      headerAction={
        section === 'professionals' ? (
          <button
            type="button"
            onClick={() => setShowCreatePro(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Novo profissional</span>
          </button>
        ) : section === 'reports' && reportsData ? (
          <button
            type="button"
            onClick={() => exportToCsv('relatorio-aurum-prive.csv', reportsData.rows)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Exportar CSV</span>
          </button>
        ) : null
      }
    >
      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-300">{error}</div>
      )}
      {notice && (
        <div className="mb-4 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
          {notice}
        </div>
      )}

      {loading && (section !== 'settings' || !settingsData) ? (
        <div className="h-64 rounded-2xl border border-white/10 bg-[#111115] animate-pulse" />
      ) : section === 'dashboard' && dash ? (
        <div className="space-y-8">
          {dash.hasDemoData && (
            <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 flex flex-wrap items-center justify-between gap-4">
              <div className="text-xs text-amber-200">
                <strong>Ambiente com Dados de Demonstração:</strong> Indicadores calculados em tempo real sobre os
                registros ativos do banco de dados (incluindo dados demo).
              </div>
              <button
                type="button"
                onClick={handleClearDemo}
                className="px-3.5 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-xs font-medium text-amber-200 hover:bg-amber-500/30 cursor-pointer"
              >
                Remover dados de demonstração
              </button>
            </div>
          )}

          {/* Complete Executive KPI Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Faturamento bruto</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#E5C97B] mt-1">
                {formatBRL(dash.financials?.gross_revenue_cents)}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1 font-mono tabular-nums">
                Receita plataforma: {formatBRL(dash.financials?.platform_revenue_cents)}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Repasses e pendências</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {formatBRL(dash.financials?.professional_share_cents)}
              </div>
              <div className="text-[11px] text-amber-400 mt-1 font-mono tabular-nums">
                Saques pendentes: {formatBRL(dash.pendingPayouts?.total_cents)} · Pag. pendentes:{' '}
                {dash.pendingPayments?.count || 0}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Profissionais e clientes</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {dash.proStats?.active || 0}/{dash.proStats?.total || 0} prof. · {dash.clientStats?.total || 0} cli.
              </div>
              <div className="text-[11px] text-emerald-400 mt-1 font-mono tabular-nums">
                {dash.proStats?.online || 0} online agora · +{dash.clientStats?.new_30d || 0} novos clientes (30d)
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Chamadas e conversão</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {dash.callStats?.completed || 0} realizadas · {dash.callStats?.in_progress || 0} ativas
              </div>
              <div className="text-[11px] text-zinc-400 mt-1 font-mono tabular-nums">
                Conversão: {dash.conversionRate}% · Canceladas: {dash.callStats?.cancelled || 0}
              </div>
            </div>
          </div>

          {/* Period Toggle + Revenue & Calls Chart */}
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[#F5F2EB]">Desempenho financeiro e volume de chamadas</div>
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

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7">
                <RevenueChart
                  title="Faturamento bruto por período"
                  subtitle="Agregado diretamente do ledger financial_transactions"
                  data={(dash.revenueSeries || []).map((r: Record<string, any>) => ({
                    label: r.day,
                    valueCents: Number(r.gross_cents),
                    secondaryValue: Number(r.calls),
                  }))}
                />
              </div>

              <div className="lg:col-span-5 rounded-xl border border-white/10 bg-[#111115] p-6">
                <div className="text-sm font-semibold text-[#F5F2EB] mb-1">Volume de chamadas e receita líquida</div>
                <div className="text-xs text-zinc-400 mb-4">Receita da plataforma e chamadas pagas por período</div>
                {(dash.revenueSeries || []).length === 0 ? (
                  <div className="h-44 flex items-center justify-center text-xs text-zinc-500">
                    Sem chamadas registradas neste recorte.
                  </div>
                ) : (
                  <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
                    {(dash.revenueSeries || []).map((r: Record<string, any>) => (
                      <div key={r.day} className="space-y-1">
                        <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                          <span className="text-zinc-300">{r.day}</span>
                          <span className="text-[#E5C97B]">
                            {r.calls} chamadas · {formatBRL(r.platform_cents)} taxa
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className="h-full bg-[#D4AF37]"
                            style={{ width: `${Math.min(100, Math.max(8, Number(r.calls) * 20))}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Dual Rankings */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl border border-white/10 bg-[#111115] p-6">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F5F2EB] mb-4">
                <BarChart3 className="w-4 h-4 text-[#D4AF37]" />
                <span>Ranking por faturamento bruto</span>
              </div>
              <div className="divide-y divide-white/10">
                {(dash.topProfessionals || []).map((p: Record<string, any>) => (
                  <div key={p.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[#F5F2EB] truncate">{p.professional_name}</div>
                      <div className="text-[11px] text-zinc-500">
                        {p.category} · Comissão {p.commission_percentage}%
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-mono tabular-nums text-[#E5C97B]">{formatBRL(p.gross_cents)}</div>
                      <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                        Taxa: {formatBRL(p.platform_fee_cents)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#111115] p-6">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F5F2EB] mb-4">
                <Video className="w-4 h-4 text-[#D4AF37]" />
                <span>Ranking por quantidade de atendimentos</span>
              </div>
              <div className="divide-y divide-white/10">
                {(dash.topByCalls || []).map((p: Record<string, any>) => (
                  <div key={p.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[#F5F2EB] truncate">{p.professional_name}</div>
                      <div className="text-[11px] text-zinc-500">{p.category}</div>
                    </div>
                    <div className="text-right shrink-0 font-mono tabular-nums">
                      <div className="text-xs text-[#F5F2EB]">{p.call_count} atendimentos</div>
                      <div className="text-[11px] text-zinc-500">{formatDurationSeconds(p.total_seconds)} acumulados</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : section === 'professionals' ? (
        <div className="space-y-4">
          {/* Search & Filters */}
          <div className="rounded-xl border border-white/10 bg-[#111115] p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="relative sm:col-span-2">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar por nome, e-mail ou categoria..."
                value={proSearch}
                onChange={(e) => setProSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
              />
            </div>
            <select
              value={proApprovalFilter}
              onChange={(e) => setProApprovalFilter(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="all">Todas aprovações</option>
              <option value="approved">Aprovados</option>
              <option value="pending">Pendentes</option>
            </select>
            <select
              value={proAvailFilter}
              onChange={(e) => setProAvailFilter(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="all">Todos os status</option>
              <option value="online">Online</option>
              <option value="busy">Em atendimento</option>
              <option value="offline">Offline</option>
            </select>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Profissional</th>
                    <th className="py-3.5 px-5 font-medium">Categoria</th>
                    <th className="py-3.5 px-5 font-medium">Sessão / Min</th>
                    <th className="py-3.5 px-5 font-medium">Comissão</th>
                    <th className="py-3.5 px-5 font-medium">Saldo disp.</th>
                    <th className="py-3.5 px-5 font-medium">Status</th>
                    <th className="py-3.5 px-5 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {pros.map((p) => {
                    const av = availabilityLabel(p.availability_status);
                    return (
                      <tr key={p.id} className="hover:bg-white/[0.02]">
                        <td className="py-3.5 px-5">
                          <div className="font-medium text-[#F5F2EB]">{p.professional_name}</div>
                          <div className="text-[11px] text-zinc-500">{p.email}</div>
                        </td>
                        <td className="py-3.5 px-5 text-zinc-300">{p.category}</td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                          {formatBRL(p.price_per_session_cents)} ({p.session_duration}m)
                          <div className="text-[11px] text-zinc-500">{formatBRL(p.price_per_minute_cents)}/min</div>
                        </td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">{p.commission_percentage}%</td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                          {formatBRL(p.available_cents)}
                        </td>
                        <td className="py-3.5 px-5">
                          <div className={p.is_approved ? 'text-emerald-400' : 'text-amber-400'}>
                            {p.is_approved ? 'Aprovado' : 'Pendente'} · {p.account_status}
                          </div>
                          <div className={`text-[11px] ${av.colorClass}`}>{av.label}</div>
                        </td>
                        <td className="py-3.5 px-5 text-right space-x-1.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() =>
                              setEditingPro({
                                ...p,
                                _priceSessionBRL: (Number(p.price_per_session_cents) / 100).toFixed(2),
                                _priceMinuteBRL: (Number(p.price_per_minute_cents || 0) / 100).toFixed(2),
                              })
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-[#D4AF37]/40 text-[#E5C97B] hover:bg-[#D4AF37]/10 cursor-pointer"
                          >
                            <Edit3 className="w-3 h-3" />
                            <span>Editar</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              runAction(async () => {
                                await apiFetch(`/api/admin/professionals/${p.id}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ isApproved: !p.is_approved }),
                                });
                              }, p.is_approved ? 'Aprovação suspensa.' : 'Profissional aprovado.')
                            }
                            className="px-2.5 py-1 rounded border border-white/15 text-zinc-200 hover:bg-white/5 cursor-pointer"
                          >
                            {p.is_approved ? 'Desativar' : 'Aprovar'}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              runAction(async () => {
                                await apiFetch(`/api/admin/professionals/${p.id}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({
                                    accountStatus: p.account_status === 'active' ? 'blocked' : 'active',
                                  }),
                                });
                              }, 'Status da conta atualizado.')
                            }
                            className="px-2.5 py-1 rounded border border-white/15 text-zinc-300 hover:text-amber-400 cursor-pointer"
                          >
                            {p.account_status === 'active' ? 'Bloquear' : 'Desbloquear'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!confirm(`Excluir permanentemente ${p.professional_name}?`)) return;
                              runAction(async () => {
                                await apiFetch(`/api/admin/professionals/${p.id}`, { method: 'DELETE' });
                              }, 'Profissional excluído.');
                            }}
                            aria-label="Excluir profissional"
                            className="p-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 cursor-pointer align-middle"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : section === 'clients' ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-[#111115] p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="relative sm:col-span-2">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar cliente por nome, e-mail ou telefone..."
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
              />
            </div>
            <select
              value={clientStatusFilter}
              onChange={(e) => setClientStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="all">Todos os status</option>
              <option value="active">Ativos</option>
              <option value="blocked">Bloqueados</option>
              <option value="suspended">Suspensos</option>
            </select>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Cliente</th>
                    <th className="py-3.5 px-5 font-medium">Cadastro</th>
                    <th className="py-3.5 px-5 font-medium">Sessões</th>
                    <th className="py-3.5 px-5 font-medium">Total gasto</th>
                    <th className="py-3.5 px-5 font-medium">Status</th>
                    <th className="py-3.5 px-5 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {clients.map((c) => (
                    <tr key={c.id}>
                      <td className="py-3.5 px-5">
                        <div className="font-medium text-[#F5F2EB]">{c.full_name}</div>
                        <div className="text-[11px] text-zinc-500">
                          {c.email} {c.phone ? `· ${c.phone}` : ''}
                        </div>
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">{formatDateTime(c.created_at)}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">{c.total_bookings}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                        {formatBRL(c.total_spent_cents)}
                      </td>
                      <td className={`py-3.5 px-5 font-medium ${c.status === 'active' ? 'text-emerald-400' : 'text-red-400'}`}>
                        {c.status}
                      </td>
                      <td className="py-3.5 px-5 text-right space-x-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setEditingClient({ ...c })}
                          className="px-2.5 py-1 rounded border border-[#D4AF37]/40 text-[#E5C97B] cursor-pointer"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            runAction(async () => {
                              await apiFetch(`/api/admin/clients/${c.user_id}/status`, {
                                method: 'PATCH',
                                body: JSON.stringify({ status: c.status === 'active' ? 'blocked' : 'active' }),
                              });
                            }, 'Status do cliente atualizado.')
                          }
                          className="px-2.5 py-1 rounded border border-white/15 text-zinc-200 hover:bg-white/5 cursor-pointer"
                        >
                          {c.status === 'active' ? 'Bloquear' : 'Ativar'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : section === 'bookings' ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-[#111115] p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="relative sm:col-span-2">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar por cliente ou profissional..."
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
              <option value="aguardando_pagamento">Aguardando pagamento</option>
              <option value="pagamento_confirmado">Pagamento confirmado</option>
              <option value="em_andamento">Em andamento</option>
              <option value="finalizada">Finalizada</option>
              <option value="cancelada">Cancelada</option>
            </select>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Cliente</th>
                    <th className="py-3.5 px-5 font-medium">Profissional</th>
                    <th className="py-3.5 px-5 font-medium">Agendamento</th>
                    <th className="py-3.5 px-5 font-medium">Modalidade</th>
                    <th className="py-3.5 px-5 font-medium">Valor</th>
                    <th className="py-3.5 px-5 font-medium">Status</th>
                    <th className="py-3.5 px-5 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {bookings.map((b) => (
                    <tr key={b.id}>
                      <td className="py-3.5 px-5 text-[#F5F2EB]">{b.client_name}</td>
                      <td className="py-3.5 px-5 text-zinc-300">{b.professional_name}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">{formatDateTime(b.scheduled_at)}</td>
                      <td className="py-3.5 px-5 text-zinc-400">
                        {b.billing_mode === 'per_minute' ? 'Por minuto' : 'Sessão'} ({b.duration_minutes}m)
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">{formatBRL(b.amount_cents)}</td>
                      <td className={`py-3.5 px-5 font-medium ${bookingStatusLabel(b.status).colorClass}`}>
                        {bookingStatusLabel(b.status).label}
                      </td>
                      <td className="py-3.5 px-5 text-right">
                        {b.status !== 'cancelada' && b.status !== 'finalizada' && (
                          <button
                            type="button"
                            onClick={() =>
                              runAction(async () => {
                                await apiFetch(`/api/admin/bookings/${b.id}/cancel`, {
                                  method: 'POST',
                                  body: JSON.stringify({ reason: 'Cancelamento administrativo' }),
                                });
                              }, 'Agendamento cancelado.')
                            }
                            className="px-2.5 py-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 cursor-pointer"
                          >
                            Cancelar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : section === 'calls' ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-[#111115] p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="relative sm:col-span-2">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar por sala, cliente ou profissional..."
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
            </select>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Sala</th>
                    <th className="py-3.5 px-5 font-medium">Participantes</th>
                    <th className="py-3.5 px-5 font-medium">Duração real</th>
                    <th className="py-3.5 px-5 font-medium">Valor</th>
                    <th className="py-3.5 px-5 font-medium">Status</th>
                    <th className="py-3.5 px-5 font-medium text-right">Controle</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {calls.map((c) => (
                    <tr key={c.id}>
                      <td className="py-3.5 px-5 font-mono text-zinc-400">{c.room_name}</td>
                      <td className="py-3.5 px-5 text-zinc-200">
                        {c.client_name} → {c.professional_name}
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                        {formatDurationSeconds(c.duration_seconds)} ({c.duration_minutes}m)
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">{formatBRL(c.amount_cents)}</td>
                      <td className={`py-3.5 px-5 font-medium ${bookingStatusLabel(c.call_status).colorClass}`}>
                        {bookingStatusLabel(c.call_status).label}
                      </td>
                      <td className="py-3.5 px-5 text-right">
                        {['em_andamento', 'aguardando_profissional', 'aguardando_cliente'].includes(c.call_status) && (
                          <button
                            type="button"
                            onClick={() =>
                              runAction(async () => {
                                await apiFetch(`/api/admin/calls/${c.id}/force-end`, { method: 'POST' });
                              }, 'Chamada encerrada administrativamente.')
                            }
                            className="px-2.5 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/30 cursor-pointer"
                          >
                            Encerrar sala
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : section === 'payments' ? (
        <div className="space-y-6">
          {gatewayStatus && (
            <div className="rounded-xl border border-white/10 bg-[#111115] p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-4">
                <div>
                  <span className="text-zinc-400">Mercado Pago: </span>
                  <span className={gatewayStatus.mercadopagoEnabled ? 'text-emerald-400 font-semibold' : 'text-zinc-500'}>
                    {gatewayStatus.mercadopagoEnabled ? 'Ativo' : 'Desativado'}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-400">PayPal: </span>
                  <span className={gatewayStatus.paypalEnabled ? 'text-emerald-400 font-semibold' : 'text-zinc-500'}>
                    {gatewayStatus.paypalEnabled ? 'Ativo' : 'Desativado'}
                  </span>
                </div>
              </div>
              <div className="text-zinc-400">
                Ambiente padrão MP:{' '}
                <span className="font-semibold text-[#E5C97B]">
                  {gatewayStatus.environment === 'production'
                    ? 'Produção'
                    : gatewayStatus.environment === 'sandbox'
                      ? 'Sandbox API'
                      : 'Sandbox Local'}
                </span>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-white/10 bg-[#111115] p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="relative sm:col-span-2">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar por cliente, profissional ou ID externo..."
                value={paymentSearch}
                onChange={(e) => setPaymentSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
              />
            </div>
            <select
              value={paymentGatewayFilter}
              onChange={(e) => setPaymentGatewayFilter(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="all">Todos os gateways</option>
              <option value="mercadopago">Mercado Pago</option>
              <option value="paypal">PayPal</option>
            </select>
            <select
              value={paymentStatusFilter}
              onChange={(e) => setPaymentStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="all">Todos os status</option>
              <option value="approved">Aprovados</option>
              <option value="pending">Pendentes</option>
              <option value="rejected">Recusados</option>
              <option value="cancelled">Cancelados</option>
              <option value="refunded">Estornados</option>
            </select>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Cliente / Profissional</th>
                    <th className="py-3.5 px-5 font-medium">Gateway / Método</th>
                    <th className="py-3.5 px-5 font-medium">Bruto / Taxa GW</th>
                    <th className="py-3.5 px-5 font-medium">Comissão / Prof.</th>
                    <th className="py-3.5 px-5 font-medium">Status / Datas</th>
                    <th className="py-3.5 px-5 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td className="py-3.5 px-5">
                        <div className="font-medium text-[#F5F2EB]">{p.client_name}</div>
                        <div className="text-[11px] text-zinc-400">{p.professional_name}</div>
                      </td>
                      <td className="py-3.5 px-5 text-zinc-400">
                        <div className="font-medium text-zinc-200">
                          {gatewayLabel(p.provider)} · <span className="uppercase">{p.payment_method}</span>
                        </div>
                        <div className="text-[10px] font-mono text-zinc-500">
                          {p.gateway_environment || 'sandbox'} {p.provider_payment_id ? `· ${p.provider_payment_id}` : ''}
                        </div>
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums">
                        <div className="text-[#E5C97B]">{formatMoney(p.amount_cents, p.currency || 'BRL')}</div>
                        <div className="text-[10px] text-zinc-500">
                          Taxa GW: {formatMoney(p.gateway_fee_cents || 0, p.currency || 'BRL')}
                        </div>
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums">
                        <div className="text-emerald-400">Plat.: {formatBRL(p.platform_fee_cents || 0)}</div>
                        <div className="text-[10px] text-zinc-400">Prof.: {formatBRL(p.professional_cents || 0)}</div>
                      </td>
                      <td className="py-3.5 px-5">
                        <div className={`font-medium ${bookingStatusLabel(p.status).colorClass}`}>
                          {bookingStatusLabel(p.status).label}
                        </div>
                        <div className="text-[10px] font-mono text-zinc-500">
                          {p.refunded_at
                            ? `Estorno: ${formatDateTime(p.refunded_at)}`
                            : p.confirmed_at || p.paid_at
                              ? `Conf.: ${formatDateTime(p.confirmed_at || p.paid_at)}`
                              : `Criado: ${formatDateTime(p.created_at)}`}
                        </div>
                        {p.provider_refund_id && (
                          <div className="text-[10px] font-mono text-zinc-500">Ref: {p.provider_refund_id}</div>
                        )}
                      </td>
                      <td className="py-3.5 px-5 text-right whitespace-nowrap">
                        {p.status === 'pending' && (
                          <button
                            type="button"
                            onClick={() =>
                              runAction(async () => {
                                await apiFetch(`/api/admin/payments/${p.id}/cancel`, {
                                  method: 'POST',
                                  body: JSON.stringify({ reason: 'Cancelado pela administração' }),
                                });
                              }, 'Pagamento pendente cancelado.')
                            }
                            className="px-2.5 py-1 rounded border border-white/15 text-zinc-300 hover:text-amber-300 cursor-pointer"
                          >
                            Cancelar
                          </button>
                        )}
                        {p.status === 'approved' && confirmRefundId !== p.id && (
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmRefundId(p.id);
                              setRefundReason('Estorno administrativo integral');
                            }}
                            className="px-2.5 py-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 cursor-pointer"
                          >
                            Estornar
                          </button>
                        )}
                        {p.status === 'approved' && confirmRefundId === p.id && (
                          <div className="inline-flex items-center gap-2">
                            <input
                              type="text"
                              value={refundReason}
                              onChange={(e) => setRefundReason(e.target.value)}
                              className="w-40 px-2 py-1 rounded bg-[#09090B] border border-white/15 text-[11px] text-white"
                              placeholder="Motivo do estorno"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                runAction(async () => {
                                  await apiFetch(`/api/admin/payments/${p.id}/refund`, {
                                    method: 'POST',
                                    body: JSON.stringify({ reason: refundReason }),
                                  });
                                  setConfirmRefundId(null);
                                }, 'Estorno processado e saldo atualizado no ledger.');
                              }}
                              className="px-2.5 py-1 rounded bg-red-600 text-white text-[11px] font-semibold cursor-pointer"
                            >
                              Confirmar
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmRefundId(null)}
                              className="px-2 py-1 text-[11px] text-zinc-400 hover:text-white cursor-pointer"
                            >
                              Cancelar
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {webhookEvents.length > 0 && (
            <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
              <div className="p-4 border-b border-white/10 text-xs font-semibold text-[#F5F2EB]">
                Eventos de Webhook Validados ({webhookEvents.length})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/10 text-zinc-400">
                    <tr>
                      <th className="py-3 px-4 font-medium">Provedor</th>
                      <th className="py-3 px-4 font-medium">Evento</th>
                      <th className="py-3 px-4 font-medium">Recurso</th>
                      <th className="py-3 px-4 font-medium">Assinatura</th>
                      <th className="py-3 px-4 font-medium">Resultado</th>
                      <th className="py-3 px-4 font-medium">Data</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {webhookEvents.map((ev) => (
                      <tr key={ev.id}>
                        <td className="py-2.5 px-4 uppercase text-zinc-300">{gatewayLabel(ev.provider)}</td>
                        <td className="py-2.5 px-4 font-mono text-zinc-300">{ev.event_type}</td>
                        <td className="py-2.5 px-4 font-mono text-zinc-400">{ev.resource_id || '—'}</td>
                        <td className={`py-2.5 px-4 ${ev.signature_valid ? 'text-emerald-400' : 'text-red-400'}`}>
                          {ev.signature_valid ? 'Válida' : 'Inválida'}
                        </td>
                        <td className="py-2.5 px-4 text-zinc-300">{ev.processing_status}</td>
                        <td className="py-2.5 px-4 font-mono tabular-nums text-zinc-500">{formatDateTime(ev.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : section === 'gateways' ? (
        <div className="space-y-8">
          {/* Comparativo Financeiro por Gateway */}
          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#F5F2EB]">
                  Comparativo Financeiro por Gateway
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Faturamento aprovado, taxas cobradas, comissão da plataforma, valores pendentes e estornos por provedor.
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Gateway</th>
                    <th className="py-3.5 px-5 font-medium">Faturamento Aprovado</th>
                    <th className="py-3.5 px-5 font-medium">Taxas Gateway</th>
                    <th className="py-3.5 px-5 font-medium">Comissão Plataforma</th>
                    <th className="py-3.5 px-5 font-medium">Líquido Profissionais</th>
                    <th className="py-3.5 px-5 font-medium">Aprov. / Pend. / Recus. / Estorn.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {gatewaysList.map((gw) => {
                    const m = gw.metrics || {};
                    return (
                      <tr key={gw.id}>
                        <td className="py-3.5 px-5">
                          <div className="font-semibold text-[#F5F2EB]">{gw.displayName}</div>
                          <div className={`text-[11px] ${gw.isEnabled ? 'text-emerald-400' : 'text-zinc-500'}`}>
                            {gw.isEnabled ? 'Ativo' : 'Desativado'} · {gw.environment}
                          </div>
                        </td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                          {formatBRL(m.gross_approved_cents)}
                        </td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                          {formatBRL(m.gateway_fee_cents)}
                        </td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-emerald-400">
                          {formatBRL(m.platform_fee_cents)}
                        </td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-200">
                          {formatBRL(m.professional_cents)}
                        </td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                          <span className="text-emerald-400">{m.approved_count || 0}</span> /{' '}
                          <span className="text-amber-400">{m.pending_count || 0}</span> /{' '}
                          <span className="text-red-400">{(m.rejected_count || 0) + (m.cancelled_count || 0)}</span> /{' '}
                          <span className="text-zinc-400">{m.refunded_count || 0}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Gateway Configuration Cards (Mercado Pago & PayPal) */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {gatewaysList.map((gw) => {
              const draft = gatewayDrafts[gw.id] || {
                isEnabled: gw.isEnabled,
                environment: gw.environment,
                splitEnabled: gw.splitEnabled,
                complianceVerified: gw.complianceVerified,
                complianceNotes: gw.complianceNotes,
              };
              const credInput = gatewayCredInputs[gw.id] || {};
              const masked = gw.maskedCredentials || {};
              const testRes = gatewayTestResults[gw.id];
              const isMp = gw.id === 'mercadopago';

              return (
                <div key={gw.id} className="rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-white/10">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-display text-xl font-semibold text-[#F5F2EB]">{gw.displayName}</h3>
                        <span
                          className={`text-[11px] font-medium px-2 py-0.5 rounded border ${
                            draft.isEnabled
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                              : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {draft.isEnabled ? 'Habilitado no Checkout' : 'Desativado'}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1">
                        {isMp
                          ? 'Checkout Pro, PIX instantâneo, Cartão de Crédito/Débito, Webhooks e Reembolsos.'
                          : 'PayPal Checkout, Conta PayPal, Cartões, Pagamento Internacional (BRL/USD/EUR) e Captura Server-Side.'}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setGatewayDrafts({
                          ...gatewayDrafts,
                          [gw.id]: { ...draft, isEnabled: !draft.isEnabled },
                        })
                      }
                      className={`px-3.5 py-2 rounded-lg text-xs font-semibold cursor-pointer border ${
                        draft.isEnabled
                          ? 'border-red-500/30 text-red-300 hover:bg-red-500/10'
                          : 'border-[#D4AF37]/40 bg-[#D4AF37] text-[#09090B]'
                      }`}
                    >
                      {draft.isEnabled ? 'Desativar gateway' : 'Ativar gateway'}
                    </button>
                  </div>

                  {/* Health Status */}
                  <div className="p-3.5 rounded-xl bg-[#09090B] border border-white/10 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-zinc-400">Status da integração:</span>
                      <span className={gw.hasLiveCredentials ? 'text-emerald-400 font-medium' : 'text-amber-300 font-medium'}>
                        {gw.lastHealthStatus}
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-400">{gw.lastHealthMessage}</div>
                    {testRes && (
                      <div className={`pt-1 text-[11px] font-medium ${testRes.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                        Teste recente: {testRes.message}
                      </div>
                    )}
                  </div>

                  {/* Environment & Marketplace Split */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-zinc-300 mb-1.5">Ambiente</label>
                      <select
                        value={draft.environment}
                        onChange={(e) =>
                          setGatewayDrafts({
                            ...gatewayDrafts,
                            [gw.id]: { ...draft, environment: e.target.value },
                          })
                        }
                        className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
                      >
                        <option value="sandbox">Sandbox (Testes)</option>
                        <option value="production">Produção (Requer conformidade)</option>
                      </select>
                    </div>
                    <div className="flex items-end pb-1">
                      <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(draft.splitEnabled)}
                          onChange={(e) =>
                            setGatewayDrafts({
                              ...gatewayDrafts,
                              [gw.id]: { ...draft, splitEnabled: e.target.checked },
                            })
                          }
                        />
                        <span>
                          {isMp ? 'Habilitar Split (application_fee)' : 'Habilitar PayPal Marketplace Split'}
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Compliance Verification Gate for Production */}
                  <div className="p-3.5 rounded-xl border border-amber-500/20 bg-amber-500/5 space-y-2.5">
                    <label className="flex items-start gap-2.5 text-xs text-amber-100 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(draft.complianceVerified)}
                        onChange={(e) =>
                          setGatewayDrafts({
                            ...gatewayDrafts,
                            [gw.id]: { ...draft, complianceVerified: e.target.checked },
                          })
                        }
                        className="mt-0.5"
                      />
                      <span>
                        Confirmo que o modelo de negócio, os serviços oferecidos e a estrutura de repasse da plataforma
                        foram aprovados nas políticas comerciais do {gw.displayName} (obrigatório para Produção).
                      </span>
                    </label>
                    <input
                      type="text"
                      value={draft.complianceNotes}
                      onChange={(e) =>
                        setGatewayDrafts({
                          ...gatewayDrafts,
                          [gw.id]: { ...draft, complianceNotes: e.target.value },
                        })
                      }
                      placeholder="Observações de conformidade / aprovação comercial..."
                      className="w-full px-3 py-1.5 rounded-lg bg-[#09090B] border border-white/10 text-[11px] text-zinc-300"
                    />
                  </div>

                  {/* Encrypted Write-Only Credentials */}
                  <div className="space-y-3 pt-1">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                      <KeyRound className="w-3.5 h-3.5 text-[#D4AF37]" />
                      <span>Credenciais criptografadas no servidor (nunca expostas no frontend)</span>
                    </div>

                    {isMp ? (
                      <div className="grid grid-cols-1 gap-2.5">
                        <div>
                          <label className="block text-[11px] text-zinc-400 mb-1">
                            Access Token {masked.hasAccessToken ? `(Atual: ${masked.accessTokenHint})` : '(não definido)'}
                          </label>
                          <input
                            type="password"
                            autoComplete="off"
                            placeholder="Deixe vazio para manter o token atual"
                            value={credInput.accessToken || ''}
                            onChange={(e) =>
                              setGatewayCredInputs({
                                ...gatewayCredInputs,
                                [gw.id]: { ...credInput, accessToken: e.target.value },
                              })
                            }
                            className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-zinc-400 mb-1">
                            Webhook Secret {masked.hasWebhookSecret ? `(Atual: ${masked.webhookSecretHint})` : '(não definido)'}
                          </label>
                          <input
                            type="password"
                            autoComplete="off"
                            placeholder="Deixe vazio para manter o segredo HMAC atual"
                            value={credInput.webhookSecret || ''}
                            onChange={(e) =>
                              setGatewayCredInputs({
                                ...gatewayCredInputs,
                                [gw.id]: { ...credInput, webhookSecret: e.target.value },
                              })
                            }
                            className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white font-mono"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2.5">
                        <div>
                          <label className="block text-[11px] text-zinc-400 mb-1">
                            PayPal Client ID {masked.hasClientId ? `(Atual: ${masked.clientIdHint})` : '(não definido)'}
                          </label>
                          <input
                            type="password"
                            autoComplete="off"
                            placeholder="Deixe vazio para manter o Client ID atual"
                            value={credInput.clientId || ''}
                            onChange={(e) =>
                              setGatewayCredInputs({
                                ...gatewayCredInputs,
                                [gw.id]: { ...credInput, clientId: e.target.value },
                              })
                            }
                            className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-zinc-400 mb-1">
                            PayPal Client Secret {masked.hasClientSecret ? `(Atual: ${masked.clientSecretHint})` : '(não definido)'}
                          </label>
                          <input
                            type="password"
                            autoComplete="off"
                            placeholder="Deixe vazio para manter o Client Secret atual"
                            value={credInput.clientSecret || ''}
                            onChange={(e) =>
                              setGatewayCredInputs({
                                ...gatewayCredInputs,
                                [gw.id]: { ...credInput, clientSecret: e.target.value },
                              })
                            }
                            className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-zinc-400 mb-1">
                            PayPal Webhook ID {masked.hasWebhookId ? `(Atual: ${masked.webhookIdHint})` : '(não definido)'}
                          </label>
                          <input
                            type="text"
                            autoComplete="off"
                            placeholder="ID do webhook cadastrado no PayPal Developer"
                            value={credInput.webhookId || ''}
                            onChange={(e) =>
                              setGatewayCredInputs({
                                ...gatewayCredInputs,
                                [gw.id]: { ...credInput, webhookId: e.target.value },
                              })
                            }
                            className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white font-mono"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="pt-3 border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={async () => {
                        setError('');
                        try {
                          const test = await apiFetch<{ ok: boolean; status: string; message: string }>(
                            `/api/admin/gateways/${gw.id}/test`,
                            { method: 'POST' }
                          );
                          setGatewayTestResults({ ...gatewayTestResults, [gw.id]: test });
                          loadSection();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Erro ao testar gateway.');
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/15 text-xs text-zinc-200 hover:bg-white/5 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Testar conexão</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        runAction(async () => {
                          await apiFetch(`/api/admin/gateways/${gw.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({
                              ...draft,
                              credentials: gatewayCredInputs[gw.id] || {},
                            }),
                          });
                          setGatewayCredInputs({ ...gatewayCredInputs, [gw.id]: {} });
                        }, `Configurações do ${gw.displayName} salvas com criptografia AES-256-GCM.`)
                      }
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] cursor-pointer"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>Salvar {gw.displayName}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {webhookEvents.length > 0 && (
            <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
              <div className="p-4 border-b border-white/10 text-xs font-semibold text-[#F5F2EB]">
                Logs de Transações e Webhooks por Gateway ({webhookEvents.length})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/10 text-zinc-400">
                    <tr>
                      <th className="py-3 px-4 font-medium">Gateway</th>
                      <th className="py-3 px-4 font-medium">Evento</th>
                      <th className="py-3 px-4 font-medium">ID Externo</th>
                      <th className="py-3 px-4 font-medium">Assinatura</th>
                      <th className="py-3 px-4 font-medium">Status</th>
                      <th className="py-3 px-4 font-medium">Data</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {webhookEvents.map((ev) => (
                      <tr key={ev.id}>
                        <td className="py-2.5 px-4 text-zinc-200 font-medium">{gatewayLabel(ev.provider)}</td>
                        <td className="py-2.5 px-4 font-mono text-zinc-300">{ev.event_type}</td>
                        <td className="py-2.5 px-4 font-mono text-zinc-400">{ev.resource_id || '—'}</td>
                        <td className={`py-2.5 px-4 ${ev.signature_valid ? 'text-emerald-400' : 'text-red-400'}`}>
                          {ev.signature_valid ? 'Validada' : 'Rejeitada'}
                        </td>
                        <td className="py-2.5 px-4 text-zinc-300">{ev.processing_status}</td>
                        <td className="py-2.5 px-4 font-mono tabular-nums text-zinc-500">{formatDateTime(ev.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : section === 'commissions' ? (
        <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
          <div className="p-6 border-b border-white/10">
            <h2 className="text-sm font-semibold text-[#F5F2EB]">Comissão individual por profissional</h2>
            <p className="text-xs text-zinc-400 mt-1">
              Defina o percentual retido pela plataforma em cada atendimento. O restante é creditado ao profissional no
              ledger financeiro.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-zinc-400">
                <tr>
                  <th className="py-3.5 px-5 font-medium">Profissional</th>
                  <th className="py-3.5 px-5 font-medium">Valor da sessão</th>
                  <th className="py-3.5 px-5 font-medium">Comissão plataforma (%)</th>
                  <th className="py-3.5 px-5 font-medium">Líquido profissional</th>
                  <th className="py-3.5 px-5 font-medium text-right">Salvar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {pros.map((p) => {
                  const pct = Number(commissionEdits[p.id] ?? p.commission_percentage);
                  const proNet = Math.round((Number(p.price_per_session_cents) * (100 - pct)) / 100);
                  return (
                    <tr key={p.id}>
                      <td className="py-3.5 px-5 font-medium text-[#F5F2EB]">
                        {p.professional_name}
                        <div className="text-[11px] text-zinc-500">{p.category}</div>
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-300">
                        {formatBRL(p.price_per_session_cents)}
                      </td>
                      <td className="py-3.5 px-5">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.5"
                          value={commissionEdits[p.id] ?? p.commission_percentage}
                          onChange={(e) => setCommissionEdits({ ...commissionEdits, [p.id]: e.target.value })}
                          className="w-24 px-2.5 py-1.5 rounded bg-[#09090B] border border-white/15 font-mono text-white"
                        />
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">{formatBRL(proNet)}</td>
                      <td className="py-3.5 px-5 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            runAction(async () => {
                              await apiFetch(`/api/admin/professionals/${p.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ commissionPercentage: Number(commissionEdits[p.id]) }),
                              });
                            }, `Comissão de ${p.professional_name} atualizada.`)
                          }
                          className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#09090B] font-semibold cursor-pointer"
                        >
                          Aplicar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : section === 'financials' ? (
        <div className="space-y-6">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              try {
                await apiFetch('/api/admin/financials/adjustment', {
                  method: 'POST',
                  body: JSON.stringify({
                    professionalId: adjProId,
                    amountCents: Math.round(Number(adjAmountBRL) * 100),
                    reason: adjReason,
                  }),
                });
                setAdjAmountBRL('');
                setAdjReason('');
                flashNotice('Lançamento de ajuste registrado no ledger.');
                loadSection();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Erro ao registrar ajuste.');
              }
            }}
            className="rounded-2xl border border-white/10 bg-[#111115] p-5 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
          >
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Profissional</label>
              <select
                value={adjProId}
                onChange={(e) => setAdjProId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
              >
                {pros.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.professional_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Ajuste em R$ (+ ou -)</label>
              <input
                required
                type="number"
                step="0.01"
                placeholder="Ex: 50.00"
                value={adjAmountBRL}
                onChange={(e) => setAdjAmountBRL(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Justificativa de auditoria</label>
              <input
                required
                type="text"
                placeholder="Motivo do lançamento"
                value={adjReason}
                onChange={(e) => setAdjReason(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
              />
            </div>
            <button
              type="submit"
              className="py-2 px-4 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
            >
              Lançar ajuste no ledger
            </button>
          </form>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Data</th>
                    <th className="py-3.5 px-5 font-medium">Tipo</th>
                    <th className="py-3.5 px-5 font-medium">Profissional</th>
                    <th className="py-3.5 px-5 font-medium">Bruto</th>
                    <th className="py-3.5 px-5 font-medium">Comissão Plataforma</th>
                    <th className="py-3.5 px-5 font-medium">Líquido Profissional</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {transactions.map((t) => (
                    <tr key={t.id}>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">{formatDateTime(t.created_at)}</td>
                      <td className="py-3.5 px-5 font-mono text-zinc-200">{t.transaction_type}</td>
                      <td className="py-3.5 px-5 text-zinc-300">{t.professional_name}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-200">{formatBRL(t.gross_cents)}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-emerald-400">
                        {formatBRL(t.platform_fee_cents)}
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                        {formatBRL(t.professional_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : section === 'payouts' && payoutsData ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Saques aguardando aprovação</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-amber-400 mt-1">
                {formatBRL(payoutsData.summary.pending_cents)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Aprovados aguardando transferência</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#E5C97B] mt-1">
                {formatBRL(payoutsData.summary.approved_cents)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-5">
              <div className="text-xs text-zinc-400">Total já repassado</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-emerald-400 mt-1">
                {formatBRL(payoutsData.summary.paid_cents)}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            {['all', 'pending', 'approved', 'paid', 'rejected'].map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setPayoutStatusFilter(st)}
                className={`px-3 py-1.5 rounded-lg text-xs border cursor-pointer ${
                  payoutStatusFilter === st
                    ? 'border-[#D4AF37] bg-[#D4AF37]/15 text-[#E5C97B]'
                    : 'border-white/10 bg-[#111115] text-zinc-400'
                }`}
              >
                {st === 'all' ? 'Todos' : bookingStatusLabel(st).label}
              </button>
            ))}
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Profissional</th>
                    <th className="py-3.5 px-5 font-medium">Valor</th>
                    <th className="py-3.5 px-5 font-medium">Método / Chave</th>
                    <th className="py-3.5 px-5 font-medium">Status</th>
                    <th className="py-3.5 px-5 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {payoutsData.payouts.map((po) => (
                    <tr key={po.id}>
                      <td className="py-3.5 px-5 font-medium text-[#F5F2EB]">
                        {po.professional_name}
                        <div className="text-[11px] text-zinc-500">{formatDateTime(po.requested_at)}</div>
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">{formatBRL(po.amount_cents)}</td>
                      <td className="py-3.5 px-5 font-mono text-zinc-400">
                        {po.payout_method.toUpperCase()} · {po.payout_details}
                      </td>
                      <td className={`py-3.5 px-5 font-medium ${bookingStatusLabel(po.status).colorClass}`}>
                        {bookingStatusLabel(po.status).label}
                      </td>
                      <td className="py-3.5 px-5 text-right space-x-2 whitespace-nowrap">
                        {po.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                runAction(async () => {
                                  await apiFetch(`/api/admin/payouts/${po.id}/approve`, { method: 'POST', body: '{}' });
                                }, 'Saque aprovado.')
                              }
                              className="px-2.5 py-1 rounded bg-[#D4AF37] text-[#09090B] font-semibold cursor-pointer"
                            >
                              Aprovar
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                runAction(async () => {
                                  await apiFetch(`/api/admin/payouts/${po.id}/reject`, {
                                    method: 'POST',
                                    body: JSON.stringify({ adminNotes: 'Recusado pela administração' }),
                                  });
                                }, 'Saque recusado e saldo estornado ao profissional.')
                              }
                              className="px-2.5 py-1 rounded border border-red-500/30 text-red-300 cursor-pointer"
                            >
                              Recusar
                            </button>
                          </>
                        )}
                        {po.status === 'approved' && (
                          <div className="inline-flex items-center gap-2">
                            <input
                              type="text"
                              placeholder="Comprovante / Ref. PIX"
                              value={payoutRefEdits[po.id] ?? ''}
                              onChange={(e) => setPayoutRefEdits({ ...payoutRefEdits, [po.id]: e.target.value })}
                              className="w-36 px-2 py-1 rounded bg-[#09090B] border border-white/15 text-[11px] text-white"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                runAction(async () => {
                                  await apiFetch(`/api/admin/payouts/${po.id}/mark-paid`, {
                                    method: 'POST',
                                    body: JSON.stringify({
                                      externalReference: payoutRefEdits[po.id] || undefined,
                                    }),
                                  });
                                }, 'Repasse confirmado como pago.')
                              }
                              className="px-2.5 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 cursor-pointer"
                            >
                              Confirmar repasse pago
                            </button>
                          </div>
                        )}
                        {po.status === 'paid' && po.external_reference && (
                          <span className="font-mono text-[11px] text-zinc-500">Ref: {po.external_reference}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : section === 'coupons' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runAction(async () => {
                await apiFetch('/api/admin/coupons', {
                  method: 'POST',
                  body: JSON.stringify({
                    code: newCouponCode,
                    discountType: newCouponType,
                    discountValue:
                      newCouponType === 'percentage'
                        ? Number(newCouponValue)
                        : Math.round(Number(newCouponValue) * 100),
                    usageLimit: newCouponLimit ? Number(newCouponLimit) : null,
                  }),
                });
                setNewCouponCode('');
              }, 'Cupom criado com sucesso.');
            }}
            className="lg:col-span-4 rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-4 h-fit"
          >
            <h2 className="text-base font-semibold">Criar cupom promocional</h2>
            <div>
              <label className="block text-xs text-zinc-300 mb-1.5">Código</label>
              <input
                required
                type="text"
                placeholder="EX: VIP20"
                value={newCouponCode}
                onChange={(e) => setNewCouponCode(e.target.value.toUpperCase())}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white uppercase"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1.5">Tipo de desconto</label>
              <select
                value={newCouponType}
                onChange={(e) => setNewCouponType(e.target.value as 'percentage' | 'fixed_cents')}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              >
                <option value="percentage">Percentual (%)</option>
                <option value="fixed_cents">Valor fixo (R$)</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">
                  {newCouponType === 'percentage' ? 'Desconto (%)' : 'Valor (R$)'}
                </label>
                <input
                  required
                  type="number"
                  min="1"
                  value={newCouponValue}
                  onChange={(e) => setNewCouponValue(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Limite de usos</label>
                <input
                  type="number"
                  min="1"
                  value={newCouponLimit}
                  onChange={(e) => setNewCouponLimit(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
            >
              Criar cupom
            </button>
          </form>

          <div className="lg:col-span-8 rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-zinc-400">
                <tr>
                  <th className="py-3.5 px-5 font-medium">Código</th>
                  <th className="py-3.5 px-5 font-medium">Desconto</th>
                  <th className="py-3.5 px-5 font-medium">Usos</th>
                  <th className="py-3.5 px-5 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {coupons.map((c) => (
                  <tr key={c.id}>
                    <td className="py-3.5 px-5 font-mono font-semibold text-[#E5C97B]">{c.code}</td>
                    <td className="py-3.5 px-5 font-mono">
                      {c.discount_type === 'percentage' ? `${c.discount_value}%` : formatBRL(c.discount_value)}
                    </td>
                    <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">
                      {c.usage_count} / {c.usage_limit ?? '∞'}
                    </td>
                    <td className="py-3.5 px-5 text-right space-x-2">
                      <button
                        type="button"
                        onClick={() =>
                          runAction(async () => {
                            await apiFetch(`/api/admin/coupons/${c.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ isActive: !c.is_active }),
                            });
                          }, 'Status do cupom atualizado.')
                        }
                        className="px-2.5 py-1 rounded border border-white/15 text-zinc-300 cursor-pointer"
                      >
                        {c.is_active ? 'Ativo' : 'Inativo'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          runAction(async () => {
                            await apiFetch(`/api/admin/coupons/${c.id}`, { method: 'DELETE' });
                          }, 'Cupom excluído.')
                        }
                        className="px-2 py-1 rounded border border-red-500/30 text-red-400 cursor-pointer"
                      >
                        Excluir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : section === 'reviews' ? (
        <div className="rounded-2xl border border-white/10 bg-[#111115] divide-y divide-white/10">
          {reviews.map((r) => (
            <div key={r.id} className="p-5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold text-[#F5F2EB]">
                  {r.client_name} avaliou {r.professional_name} · {r.rating}/5 ·{' '}
                  <span className={r.status === 'published' ? 'text-emerald-400' : 'text-amber-400'}>{r.status}</span>
                </div>
                <div className="text-xs text-zinc-400 mt-1">{r.comment}</div>
              </div>
              <button
                type="button"
                onClick={() =>
                  runAction(async () => {
                    await apiFetch(`/api/admin/reviews/${r.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ status: r.status === 'published' ? 'hidden' : 'published' }),
                    });
                  }, 'Status da avaliação atualizado.')
                }
                className="px-3 py-1.5 rounded border border-white/15 text-xs text-zinc-200 cursor-pointer"
              >
                {r.status === 'published' ? 'Ocultar' : 'Publicar'}
              </button>
            </div>
          ))}
        </div>
      ) : section === 'reports' && reportsData ? (
        <div className="space-y-6">
          {/* Multi-filter bar */}
          <div className="rounded-xl border border-white/10 bg-[#111115] p-4 grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <input
              type="date"
              value={reportFilters.from}
              onChange={(e) => setReportFilters({ ...reportFilters, from: e.target.value })}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
            />
            <input
              type="date"
              value={reportFilters.to}
              onChange={(e) => setReportFilters({ ...reportFilters, to: e.target.value })}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-white"
            />
            <select
              value={reportFilters.professionalId}
              onChange={(e) => setReportFilters({ ...reportFilters, professionalId: e.target.value })}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="">Todos os profissionais</option>
              {reportsData.proOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.professional_name}
                </option>
              ))}
            </select>
            <select
              value={reportFilters.clientId}
              onChange={(e) => setReportFilters({ ...reportFilters, clientId: e.target.value })}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="">Todos os clientes</option>
              {reportsData.clientOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name}
                </option>
              ))}
            </select>
            <select
              value={reportFilters.status}
              onChange={(e) => setReportFilters({ ...reportFilters, status: e.target.value })}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="">Todos status</option>
              <option value="finalizada">Finalizada</option>
              <option value="pagamento_confirmado">Confirmada</option>
              <option value="cancelada">Cancelada</option>
            </select>
            <select
              value={reportFilters.paymentStatus}
              onChange={(e) => setReportFilters({ ...reportFilters, paymentStatus: e.target.value })}
              className="px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-xs text-zinc-200"
            >
              <option value="">Todos pagamentos</option>
              <option value="approved">Aprovados</option>
              <option value="pending">Pendentes</option>
              <option value="refunded">Estornados</option>
            </select>
          </div>

          {/* Summary KPIs computed from filtered query */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="rounded-xl border border-white/10 bg-[#111115] p-4">
              <div className="text-[11px] text-zinc-400">Faturamento bruto</div>
              <div className="text-lg font-semibold font-mono tabular-nums text-[#E5C97B] mt-1">
                {formatBRL(reportsData.summary.grossCents)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-4">
              <div className="text-[11px] text-zinc-400">Receita plataforma</div>
              <div className="text-lg font-semibold font-mono tabular-nums text-emerald-400 mt-1">
                {formatBRL(reportsData.summary.platformCents)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-4">
              <div className="text-[11px] text-zinc-400">Ticket médio</div>
              <div className="text-lg font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {formatBRL(reportsData.summary.avgTicketCents)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#111115] p-4">
              <div className="text-[11px] text-zinc-400">Média de duração</div>
              <div className="text-lg font-semibold font-mono tabular-nums text-[#F5F2EB] mt-1">
                {formatDurationSeconds(reportsData.summary.avgDurationSec)} ({reportsData.summary.totalCalls} sessões)
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Data</th>
                    <th className="py-3.5 px-5 font-medium">Profissional</th>
                    <th className="py-3.5 px-5 font-medium">Cliente</th>
                    <th className="py-3.5 px-5 font-medium">Bruto</th>
                    <th className="py-3.5 px-5 font-medium">Plataforma</th>
                    <th className="py-3.5 px-5 font-medium">Repasse</th>
                    <th className="py-3.5 px-5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {reportsData.rows.map((row, i) => (
                    <tr key={row.booking_id || i}>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">{formatDateTime(row.scheduled_at)}</td>
                      <td className="py-3.5 px-5 text-[#F5F2EB]">{row.professional_name}</td>
                      <td className="py-3.5 px-5 text-zinc-300">{row.client_name}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-200">{formatBRL(row.gross_cents)}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-emerald-400">
                        {formatBRL(row.platform_fee_cents)}
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#E5C97B]">
                        {formatBRL(row.professional_cents)}
                      </td>
                      <td className={`py-3.5 px-5 ${bookingStatusLabel(row.booking_status).colorClass}`}>
                        {bookingStatusLabel(row.booking_status).label}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : section === 'notifications' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runAction(async () => {
                const res = await apiFetch<{ sentCount: number }>('/api/admin/notifications/broadcast', {
                  method: 'POST',
                  body: JSON.stringify({
                    audience: broadcastAudience,
                    title: broadcastTitle,
                    message: broadcastMsg,
                  }),
                });
                setBroadcastTitle('');
                setBroadcastMsg('');
                flashNotice(`Aviso enviado para ${res.sentCount} usuário(s).`);
              });
            }}
            className="lg:col-span-5 rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-4 h-fit"
          >
            <div className="flex items-center gap-2 text-base font-semibold">
              <Send className="w-4 h-4 text-[#D4AF37]" />
              <span>Enviar aviso administrativo</span>
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1.5">Público-alvo</label>
              <select
                value={broadcastAudience}
                onChange={(e) => setBroadcastAudience(e.target.value as 'all' | 'professionals' | 'clients')}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              >
                <option value="all">Todos os usuários ativos</option>
                <option value="professionals">Apenas profissionais</option>
                <option value="clients">Apenas clientes</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1.5">Título do aviso</label>
              <input
                required
                type="text"
                value={broadcastTitle}
                onChange={(e) => setBroadcastTitle(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1.5">Mensagem</label>
              <textarea
                required
                rows={4}
                value={broadcastMsg}
                onChange={(e) => setBroadcastMsg(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
            >
              Disparar notificação
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-white/10 bg-[#111115] divide-y divide-white/10">
            {adminNotifications.map((n) => (
              <div key={n.id} className="p-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold text-[#F5F2EB]">{n.title}</div>
                  <div className="text-xs text-zinc-400 mt-1">{n.message}</div>
                  <div className="text-[11px] text-zinc-500 mt-1 font-mono">
                    Para: {n.recipient_name} ({n.recipient_role}) · {formatDateTime(n.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : section === 'settings' && settingsData ? (
        <div className="space-y-8 max-w-4xl">
          <div className="rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <h2 className="font-display text-xl font-semibold">Integrações e Conectividade Supabase</h2>
                <p className="text-xs text-zinc-400">
                  Projeto vinculado: <span className="font-mono text-[#E5C97B]">{String(settingsData.integrations.supabaseTargetUrl || 'https://jyfpqcjpwdmzmpccdekw.supabase.co')}</span>
                </p>
                <p className="text-xs text-zinc-500">
                  Configure as variáveis de ambiente nos Secrets para ativar o projeto Supabase externo, LiveKit e gateways.
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await apiFetch<{ connected: boolean; message: string }>('/api/admin/supabase-verify', {
                      method: 'POST',
                    });
                    setSupabaseVerifyResult(res);
                  } catch (err) {
                    setSupabaseVerifyResult({
                      connected: false,
                      message: err instanceof Error ? err.message : 'Credenciais não configuradas',
                    });
                  }
                }}
                className="px-4 py-2 rounded-lg border border-[#D4AF37]/40 text-xs font-medium text-[#E5C97B] hover:bg-[#D4AF37]/10 cursor-pointer"
              >
                Testar conexão Supabase
              </button>
            </div>

            {supabaseVerifyResult && (
              <div
                className={`p-3 rounded-lg border text-xs ${
                  supabaseVerifyResult.connected
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                }`}
              >
                {supabaseVerifyResult.message}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
              {[
                {
                  name: 'Supabase (PostgreSQL + RLS)',
                  ready: Boolean(settingsData.integrations.supabaseConfigured),
                  vars: 'SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_JWKS_URL',
                },
                {
                  name: 'LiveKit (Salas WebRTC)',
                  ready: Boolean(settingsData.integrations.livekitConfigured),
                  vars: 'LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET',
                },
                {
                  name: 'Mercado Pago (PIX & Cartão)',
                  ready: Boolean(settingsData.integrations.mercadoPagoConfigured),
                  vars: 'MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET',
                },
                {
                  name: 'PayPal (Checkout & Cards)',
                  ready: Boolean(settingsData.integrations.paypalConfigured),
                  vars: 'PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID',
                },
              ].map((int) => (
                <div key={int.name} className="p-4 rounded-xl border border-white/10 bg-[#09090B] space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    {int.ready ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                    <span>{int.name}</span>
                  </div>
                  <div className={`text-xs ${int.ready ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {int.ready ? 'Credenciais detectadas' : 'Pendente (operando em modo local/sandbox)'}
                  </div>
                  <div className="text-[11px] font-mono text-zinc-500 break-all">{int.vars}</div>
                </div>
              ))}
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              runAction(async () => {
                await apiFetch('/api/admin/settings', {
                  method: 'PATCH',
                  body: JSON.stringify(settingsData.settings),
                });
              }, 'Regras da plataforma atualizadas.');
            }}
            className="rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-4"
          >
            <h2 className="font-display text-xl font-semibold">Regras Globais e Cobrança</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Comissão padrão (%)</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={settingsData.settings.global_commission_percentage ?? 30}
                  onChange={(e) =>
                    setSettingsData({
                      ...settingsData,
                      settings: { ...settingsData.settings, global_commission_percentage: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Antecedência mínima (min)</label>
                <input
                  type="number"
                  min="5"
                  value={settingsData.settings.min_booking_lead_minutes ?? 30}
                  onChange={(e) =>
                    setSettingsData({
                      ...settingsData,
                      settings: { ...settingsData.settings, min_booking_lead_minutes: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Saque mínimo (R$)</label>
                <input
                  type="number"
                  min="10"
                  value={Math.round(Number(settingsData.settings.minimum_payout_cents ?? 10000) / 100)}
                  onChange={(e) =>
                    setSettingsData({
                      ...settingsData,
                      settings: {
                        ...settingsData.settings,
                        minimum_payout_cents: Math.round(Number(e.target.value) * 100),
                      },
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Janela de cancelamento (h)</label>
                <input
                  type="number"
                  min="0"
                  value={settingsData.settings.cancellation_window_hours ?? 4}
                  onChange={(e) =>
                    setSettingsData({
                      ...settingsData,
                      settings: { ...settingsData.settings, cancellation_window_hours: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Tolerância de atraso (min)</label>
                <input
                  type="number"
                  min="0"
                  value={settingsData.settings.late_tolerance_minutes ?? 5}
                  onChange={(e) =>
                    setSettingsData({
                      ...settingsData,
                      settings: { ...settingsData.settings, late_tolerance_minutes: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Reconexão permitida (seg)</label>
                <input
                  type="number"
                  min="30"
                  value={settingsData.settings.reconnect_grace_seconds ?? 120}
                  onChange={(e) =>
                    setSettingsData({
                      ...settingsData,
                      settings: { ...settingsData.settings, reconnect_grace_seconds: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-6 pt-2">
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(settingsData.settings.session_billing_enabled)}
                  onChange={(e) =>
                    setSettingsData({
                      ...settingsData,
                      settings: { ...settingsData.settings, session_billing_enabled: e.target.checked },
                    })
                  }
                />
                <span>Habilitar cobrança por sessão fixa</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(settingsData.settings.per_minute_billing_enabled)}
                  onChange={(e) =>
                    setSettingsData({
                      ...settingsData,
                      settings: { ...settingsData.settings, per_minute_billing_enabled: e.target.checked },
                    })
                  }
                />
                <span>Habilitar cobrança por minuto</span>
              </label>
            </div>

            <div className="pt-4 flex flex-wrap items-center justify-between gap-4 border-t border-white/10">
              <button
                type="submit"
                className="px-5 py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] cursor-pointer"
              >
                Salvar configurações
              </button>

              {settingsData.settings.demo_mode_enabled && (
                <button
                  type="button"
                  onClick={handleClearDemo}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-red-500/40 text-xs text-red-300 hover:bg-red-500/10 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Remover dados de demonstração</span>
                </button>
              )}
            </div>
          </form>
        </div>
      ) : section === 'audit' ? (
        <div className="space-y-4">
          <div className="relative max-w-md">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Filtrar auditoria por ação, entidade ou e-mail..."
              value={auditSearch}
              onChange={(e) => setAuditSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#111115] border border-white/15 text-xs text-white"
            />
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#111115] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-zinc-400">
                  <tr>
                    <th className="py-3.5 px-5 font-medium">Data</th>
                    <th className="py-3.5 px-5 font-medium">Ação</th>
                    <th className="py-3.5 px-5 font-medium">Ator</th>
                    <th className="py-3.5 px-5 font-medium">Entidade</th>
                    <th className="py-3.5 px-5 font-medium">Metadados</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-zinc-400">{formatDateTime(log.created_at)}</td>
                      <td className="py-3.5 px-5 font-mono text-[#E5C97B]">{log.action}</td>
                      <td className="py-3.5 px-5 text-zinc-300">{log.actor_email || 'Sistema'}</td>
                      <td className="py-3.5 px-5 font-mono text-zinc-400">
                        {log.entity_type}:{log.entity_id}
                      </td>
                      <td className="py-3.5 px-5 font-mono text-[11px] text-zinc-500 max-w-xs truncate">
                        {log.metadata}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {/* Modal: Create Professional */}
      {showCreatePro && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <form
            onSubmit={handleCreateProfessional}
            className="w-full max-w-lg rounded-2xl border border-white/15 bg-[#111115] p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-semibold">Cadastrar Novo Profissional</h2>
              <button type="button" onClick={() => setShowCreatePro(false)} className="text-zinc-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Nome civil</label>
                <input
                  required
                  type="text"
                  value={newPro.fullName}
                  onChange={(e) => setNewPro({ ...newPro, fullName: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Nome profissional</label>
                <input
                  required
                  type="text"
                  value={newPro.professionalName}
                  onChange={(e) => setNewPro({ ...newPro, professionalName: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs text-zinc-300 mb-1">E-mail de acesso</label>
                <input
                  required
                  type="email"
                  value={newPro.email}
                  onChange={(e) => setNewPro({ ...newPro, email: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Telefone</label>
                <input
                  type="text"
                  value={newPro.phone}
                  onChange={(e) => setNewPro({ ...newPro, phone: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Senha inicial (mín. 8)</label>
                <input
                  required
                  minLength={8}
                  type="password"
                  value={newPro.password}
                  onChange={(e) => setNewPro({ ...newPro, password: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Categoria</label>
                <input
                  required
                  type="text"
                  value={newPro.category}
                  onChange={(e) => setNewPro({ ...newPro, category: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Sessão (R$)</label>
                <input
                  required
                  type="number"
                  min="1"
                  value={newPro.priceSessionBRL}
                  onChange={(e) => setNewPro({ ...newPro, priceSessionBRL: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Minuto (R$)</label>
                <input
                  type="number"
                  min="0"
                  value={newPro.priceMinuteBRL}
                  onChange={(e) => setNewPro({ ...newPro, priceMinuteBRL: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Duração (m)</label>
                <input
                  required
                  type="number"
                  min="5"
                  value={newPro.sessionDuration}
                  onChange={(e) => setNewPro({ ...newPro, sessionDuration: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Comissão (%)</label>
                <input
                  required
                  type="number"
                  min="0"
                  max="100"
                  value={newPro.commissionPercentage}
                  onChange={(e) => setNewPro({ ...newPro, commissionPercentage: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1">Biografia</label>
              <textarea
                rows={3}
                value={newPro.bio}
                onChange={(e) => setNewPro({ ...newPro, bio: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowCreatePro(false)}
                className="px-4 py-2 rounded-lg border border-white/15 text-xs text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
              >
                Cadastrar profissional
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Edit Professional */}
      {editingPro && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <form
            onSubmit={handleSaveProEdit}
            className="w-full max-w-lg rounded-2xl border border-white/15 bg-[#111115] p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-semibold">Editar Profissional</h2>
              <button type="button" onClick={() => setEditingPro(null)} className="text-zinc-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Nome civil</label>
                <input
                  required
                  type="text"
                  value={editingPro.full_name || ''}
                  onChange={(e) => setEditingPro({ ...editingPro, full_name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Nome profissional</label>
                <input
                  required
                  type="text"
                  value={editingPro.professional_name || ''}
                  onChange={(e) => setEditingPro({ ...editingPro, professional_name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Categoria</label>
                <input
                  required
                  type="text"
                  value={editingPro.category || ''}
                  onChange={(e) => setEditingPro({ ...editingPro, category: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Status da conta</label>
                <select
                  value={editingPro.account_status}
                  onChange={(e) => setEditingPro({ ...editingPro, account_status: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                >
                  <option value="active">Ativo</option>
                  <option value="pending">Pendente</option>
                  <option value="suspended">Suspenso</option>
                  <option value="blocked">Bloqueado</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Sessão (R$)</label>
                <input
                  required
                  type="number"
                  step="0.01"
                  min="1"
                  value={editingPro._priceSessionBRL}
                  onChange={(e) => setEditingPro({ ...editingPro, _priceSessionBRL: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Minuto (R$)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editingPro._priceMinuteBRL}
                  onChange={(e) => setEditingPro({ ...editingPro, _priceMinuteBRL: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Duração (m)</label>
                <input
                  required
                  type="number"
                  min="5"
                  value={editingPro.session_duration}
                  onChange={(e) => setEditingPro({ ...editingPro, session_duration: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Comissão (%)</label>
                <input
                  required
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={editingPro.commission_percentage}
                  onChange={(e) => setEditingPro({ ...editingPro, commission_percentage: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-300 mb-1">Biografia</label>
              <textarea
                rows={3}
                value={editingPro.bio || ''}
                onChange={(e) => setEditingPro({ ...editingPro, bio: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              />
            </div>

            <div className="flex flex-wrap gap-5 text-xs text-zinc-300">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(editingPro.is_approved)}
                  onChange={(e) => setEditingPro({ ...editingPro, is_approved: e.target.checked })}
                />
                <span>Aprovado para catálogo público</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(editingPro.is_featured)}
                  onChange={(e) => setEditingPro({ ...editingPro, is_featured: e.target.checked })}
                />
                <span>Destaque na página inicial</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(editingPro.instant_call_enabled)}
                  onChange={(e) => setEditingPro({ ...editingPro, instant_call_enabled: e.target.checked })}
                />
                <span>Chamada imediata permitida</span>
              </label>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setEditingPro(null)}
                className="px-4 py-2 rounded-lg border border-white/15 text-xs text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
              >
                Salvar alterações
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Edit Client */}
      {editingClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <form
            onSubmit={handleSaveClientEdit}
            className="w-full max-w-md rounded-2xl border border-white/15 bg-[#111115] p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-semibold">Editar Cliente</h2>
              <button type="button" onClick={() => setEditingClient(null)} className="text-zinc-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1">Nome completo</label>
              <input
                required
                type="text"
                value={editingClient.full_name}
                onChange={(e) => setEditingClient({ ...editingClient, full_name: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1">Telefone</label>
              <input
                type="text"
                value={editingClient.phone || ''}
                onChange={(e) => setEditingClient({ ...editingClient, phone: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1">Status da conta</label>
              <select
                value={editingClient.status}
                onChange={(e) => setEditingClient({ ...editingClient, status: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
              >
                <option value="active">Ativo</option>
                <option value="suspended">Suspenso</option>
                <option value="blocked">Bloqueado</option>
              </select>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setEditingClient(null)}
                className="px-4 py-2 rounded-lg border border-white/15 text-xs text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
              >
                Salvar cliente
              </button>
            </div>
          </form>
        </div>
      )}
    </DashboardShell>
  );
}
