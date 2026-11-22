import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  Copy,
  CreditCard,
  ExternalLink,
  Globe,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { formatBRL, formatMoney, gatewayLabel } from '../../lib/format';
import type { ProfessionalProfile } from '../../types';

interface EnabledGateway {
  id: 'mercadopago' | 'paypal' | string;
  displayName: string;
  environment: 'sandbox' | 'production';
  supportedMethods: string[];
  supportedCurrencies: string[];
  hasLiveCredentials: boolean;
  healthStatus: string;
  healthMessage: string;
}

interface BookingCheckoutModalProps {
  professional: Pick<
    ProfessionalProfile,
    'id' | 'professional_name' | 'category' | 'price_per_session_cents' | 'price_per_minute_cents' | 'session_duration'
  >;
  mode: 'schedule' | 'instant' | 'pay_existing';
  bookedSlots?: string[];
  existingBooking?: {
    id: string;
    amount_cents: number;
    duration_minutes: number;
  };
  onPaid?: () => void;
  onClose: () => void;
}

const METHOD_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
  pix: { label: 'PIX', icon: <QrCode className="w-4 h-4" /> },
  credit_card: { label: 'Cartão de Crédito', icon: <CreditCard className="w-4 h-4" /> },
  debit_card: { label: 'Cartão de Débito', icon: <CreditCard className="w-4 h-4" /> },
  paypal_account: { label: 'Conta PayPal', icon: <Wallet className="w-4 h-4" /> },
  international: { label: 'Checkout Internacional', icon: <Globe className="w-4 h-4" /> },
};

export function BookingCheckoutModal({
  professional,
  mode,
  bookedSlots = [],
  existingBooking,
  onPaid,
  onClose,
}: BookingCheckoutModalProps) {
  const navigate = useNavigate();

  const defaultDate = new Date(Date.now() + 24 * 3600 * 1000);
  defaultDate.setMinutes(0, 0, 0);
  const [dateStr, setDateStr] = useState(defaultDate.toISOString().slice(0, 10));
  const [timeStr, setTimeStr] = useState('14:00');
  const [duration, setDuration] = useState(existingBooking?.duration_minutes || professional.session_duration || 30);
  const [billingMode, setBillingMode] = useState<'session' | 'per_minute'>('session');
  const [couponCode, setCouponCode] = useState('');

  const [gateways, setGateways] = useState<EnabledGateway[]>([]);
  const [gatewaysLoading, setGatewaysLoading] = useState(true);
  const [selectedGateway, setSelectedGateway] = useState<'mercadopago' | 'paypal' | string>('mercadopago');
  const [paymentMethod, setPaymentMethod] = useState<string>('pix');
  const [currency, setCurrency] = useState<string>('BRL');

  const [step, setStep] = useState<'configure' | 'checkout' | 'confirmed'>('configure');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedPix, setCopiedPix] = useState(false);

  const [checkoutData, setCheckoutData] = useState<{
    bookingId: string;
    paymentId: string;
    gateway: string;
    displayName?: string;
    environment?: string;
    providerPaymentId?: string;
    amountCents: number;
    currency: string;
    mode: string;
    pixCopyPaste?: string | null;
    pixQrBase64?: string | null;
    sandboxSignature?: string;
    checkoutUrl?: string | null;
    pendingNotice?: string;
  } | null>(null);
  const [confirmedCallId, setConfirmedCallId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await apiFetch<{ gateways: EnabledGateway[] }>('/api/payments/gateways');
        if (!active) return;
        setGateways(res.gateways);
        if (res.gateways.length > 0) {
          const first = res.gateways[0];
          setSelectedGateway(first.id);
          setPaymentMethod(first.supportedMethods[0] || (first.id === 'paypal' ? 'paypal_account' : 'pix'));
          setCurrency(first.supportedCurrencies[0] || 'BRL');
        }
      } catch {
        if (active) setError('Não foi possível carregar os meios de pagamento disponíveis.');
      } finally {
        if (active) setGatewaysLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const currentGateway = gateways.find((g) => g.id === selectedGateway) || null;

  function handleSelectGateway(gw: EnabledGateway) {
    setSelectedGateway(gw.id);
    setError('');
    if (!gw.supportedMethods.includes(paymentMethod)) {
      setPaymentMethod(gw.supportedMethods[0] || (gw.id === 'paypal' ? 'paypal_account' : 'pix'));
    }
    if (!gw.supportedCurrencies.includes(currency)) {
      setCurrency(gw.supportedCurrencies[0] || 'BRL');
    }
  }

  const baseEstimateCents = existingBooking
    ? existingBooking.amount_cents
    : billingMode === 'per_minute'
      ? (professional.price_per_minute_cents || 0) * duration
      : Math.round((professional.price_per_session_cents * duration) / (professional.session_duration || 30));

  const isLocalSandboxMode = Boolean(checkoutData?.mode.endsWith('_sandbox_local'));

  // Poll payment status automatically when waiting on hosted Mercado Pago or PayPal checkout
  useEffect(() => {
    if (step !== 'checkout' || !checkoutData?.paymentId || isLocalSandboxMode) return;
    let active = true;

    const timer = setInterval(async () => {
      try {
        const res = await apiFetch<{ status: string; call_id?: string; callId?: string; failure_reason?: string }>(
          `/api/payments/${checkoutData.paymentId}/status`
        );
        if (!active) return;
        if (res.status === 'approved') {
          setConfirmedCallId(res.callId || res.call_id || null);
          setStep('confirmed');
          onPaid?.();
        } else if (res.status === 'rejected' || res.status === 'cancelled') {
          setError(
            res.failure_reason ||
              `Pagamento não concluído em ${gatewayLabel(checkoutData.gateway)}. Escolha outro método ou gateway.`
          );
          setStep('configure');
        }
      } catch {
        // Ignore transient polling blip
      }
    }, 3500);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [step, checkoutData?.paymentId, checkoutData?.gateway, isLocalSandboxMode, onPaid]);

  async function handleCreateBookingAndCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!currentGateway) {
      setError('Nenhum gateway de pagamento disponível no momento.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      let bookingId = existingBooking?.id || '';
      if (!bookingId) {
        if (mode === 'instant') {
          const res = await apiFetch<{ booking: { id: string } }>('/api/client/instant-call', {
            method: 'POST',
            body: JSON.stringify({
              professionalId: professional.id,
              durationMinutes: duration,
              billingMode,
              couponCode,
            }),
          });
          bookingId = res.booking.id;
        } else {
          const scheduledIso = new Date(`${dateStr}T${timeStr}:00`).toISOString();
          if (bookedSlots.includes(scheduledIso)) {
            throw new Error('Este horário já está reservado. Escolha outro horário.');
          }
          const res = await apiFetch<{ booking: { id: string } }>('/api/client/bookings', {
            method: 'POST',
            body: JSON.stringify({
              professionalId: professional.id,
              scheduledAt: scheduledIso,
              durationMinutes: duration,
              billingMode,
              couponCode,
            }),
          });
          bookingId = res.booking.id;
        }
      }

      const idempotencyKey = `${selectedGateway}-${bookingId}-${paymentMethod}-${currency}`;

      const checkout = await apiFetch<{
        paymentId: string;
        gateway: string;
        displayName?: string;
        environment?: string;
        providerPaymentId?: string;
        amountCents: number;
        currency: string;
        mode: string;
        pixCopyPaste?: string | null;
        pixQrBase64?: string | null;
        sandboxSignature?: string;
        checkoutUrl?: string | null;
        pendingNotice?: string;
      }>('/api/payments/create-checkout', {
        method: 'POST',
        body: JSON.stringify({
          bookingId,
          gateway: selectedGateway,
          paymentMethod,
          currency,
          idempotencyKey,
        }),
      });

      setCheckoutData({ bookingId, ...checkout });
      setStep('checkout');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível iniciar o pagamento.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckPaymentStatusNow() {
    if (!checkoutData?.paymentId) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ status: string; call_id?: string; callId?: string; failure_reason?: string }>(
        `/api/payments/${checkoutData.paymentId}/status`
      );
      if (res.status === 'approved') {
        setConfirmedCallId(res.callId || res.call_id || null);
        setStep('confirmed');
        onPaid?.();
      } else if (res.status === 'rejected' || res.status === 'cancelled') {
        setError(res.failure_reason || 'Pagamento recusado ou cancelado no gateway. Tente outro meio de pagamento.');
        setStep('configure');
      } else {
        setError(`Pagamento ainda aguardando compensação/confirmação em ${gatewayLabel(checkoutData.gateway)}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao consultar status.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelAttempt() {
    if (!checkoutData?.paymentId) return;
    setLoading(true);
    setError('');
    try {
      await apiFetch(`/api/payments/${checkoutData.paymentId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Troca de gateway pelo cliente' }),
      });
      setCheckoutData(null);
      setStep('configure');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao cancelar tentativa.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSandboxWebhookSimulation(outcome: 'approved' | 'rejected') {
    if (!checkoutData?.sandboxSignature) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{
        confirmed?: boolean;
        rejected?: boolean;
        callId?: string;
        reason?: string;
      }>('/api/payments/webhooks/sandbox', {
        method: 'POST',
        body: JSON.stringify({
          paymentId: checkoutData.paymentId,
          sandboxSignature: checkoutData.sandboxSignature,
          outcome,
        }),
      });
      if (outcome === 'approved' && res.confirmed) {
        setConfirmedCallId(res.callId || null);
        setStep('confirmed');
        onPaid?.();
      } else {
        setError(res.reason || 'Pagamento recusado no ambiente Sandbox. A chamada permanece bloqueada.');
        setStep('configure');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao simular evento no gateway.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-white/15 bg-[#111115] p-6 shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-white/10">
          <div>
            <div className="text-xs text-[#E5C97B]">
              {mode === 'instant'
                ? 'Atendimento imediato'
                : mode === 'pay_existing'
                  ? 'Concluir pagamento da reserva'
                  : 'Agendamento de sessão privada'}
            </div>
            <h2 className="font-display text-xl font-semibold text-[#F5F2EB] mt-0.5">
              {professional.professional_name}
            </h2>
            <div className="text-xs text-zinc-400 mt-0.5">{professional.category}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-300 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {step === 'configure' && (
          <form onSubmit={handleCreateBookingAndCheckout} className="mt-5 space-y-4">
            {mode === 'schedule' && !existingBooking && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Data</label>
                  <input
                    type="date"
                    required
                    value={dateStr}
                    min={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setDateStr(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Horário</label>
                  <select
                    value={timeStr}
                    onChange={(e) => setTimeStr(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                  >
                    {['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {!existingBooking && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">Modalidade de cobrança</label>
                    <select
                      value={billingMode}
                      onChange={(e) => setBillingMode(e.target.value as 'session' | 'per_minute')}
                      className="w-full px-3 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                    >
                      <option value="session">Sessão com duração fixa</option>
                      {professional.price_per_minute_cents > 0 && (
                        <option value="per_minute">
                          Por minuto ({formatBRL(professional.price_per_minute_cents)}/min)
                        </option>
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">Duração contratada</label>
                    <select
                      value={duration}
                      onChange={(e) => setDuration(Number(e.target.value))}
                      className="w-full px-3 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                    >
                      {[15, 30, 45, 60].map((m) => (
                        <option key={m} value={m}>
                          {m} minutos
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Cupom promocional (opcional)</label>
                  <input
                    type="text"
                    placeholder="Ex: AURUM15"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white uppercase focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
              </>
            )}

            {/* Multi-Gateway Selector */}
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-2">Escolha o gateway de pagamento</label>
              {gatewaysLoading ? (
                <div className="h-20 rounded-xl bg-[#09090B] border border-white/10 animate-pulse" />
              ) : gateways.length === 0 ? (
                <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200">
                  Nenhum gateway de pagamento está habilitado no momento. Entre em contato com a administração.
                </div>
              ) : (
                <div className={`grid gap-3 ${gateways.length > 1 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
                  {gateways.map((gw) => {
                    const isSelected = selectedGateway === gw.id;
                    const isMp = gw.id === 'mercadopago';
                    return (
                      <button
                        key={gw.id}
                        type="button"
                        onClick={() => handleSelectGateway(gw)}
                        className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                          isSelected
                            ? 'border-[#D4AF37] bg-[#D4AF37]/10 ring-1 ring-[#D4AF37]/40'
                            : 'border-white/10 bg-[#09090B] hover:border-white/25'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-sm font-semibold ${isSelected ? 'text-[#E5C97B]' : 'text-[#F5F2EB]'}`}>
                            Pagar com {gw.displayName}
                          </span>
                          <span className="text-[10px] font-mono uppercase text-zinc-400">
                            {gw.environment === 'production' ? 'Produção' : 'Sandbox'}
                          </span>
                        </div>
                        <div className="text-[11px] text-zinc-400 mt-1">
                          {isMp
                            ? 'PIX instantâneo, Crédito ou Débito em BRL'
                            : 'Conta PayPal, Cartão Internacional e Multimoeda'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Dynamic Payment Methods + Currency adapted to selected gateway */}
            {currentGateway && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Método em {currentGateway.displayName}
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {currentGateway.supportedMethods.map((method) => {
                      const meta = METHOD_LABELS[method] || { label: method, icon: <CreditCard className="w-4 h-4" /> };
                      return (
                        <button
                          key={method}
                          type="button"
                          onClick={() => setPaymentMethod(method)}
                          className={`flex items-center justify-center gap-1.5 py-2.5 px-2.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                            paymentMethod === method
                              ? 'border-[#D4AF37] bg-[#D4AF37]/10 text-[#E5C97B]'
                              : 'border-white/10 bg-[#09090B] text-zinc-400 hover:text-white'
                          }`}
                        >
                          {meta.icon}
                          <span className="truncate">{meta.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {currentGateway.supportedCurrencies.length > 1 && (
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">Moeda do checkout</label>
                    <div className="flex gap-2">
                      {currentGateway.supportedCurrencies.map((cur) => (
                        <button
                          key={cur}
                          type="button"
                          onClick={() => setCurrency(cur)}
                          className={`px-3.5 py-1.5 rounded-lg border text-xs font-mono font-medium cursor-pointer ${
                            currency === cur
                              ? 'border-[#D4AF37] bg-[#D4AF37]/10 text-[#E5C97B]'
                              : 'border-white/10 bg-[#09090B] text-zinc-400 hover:text-white'
                          }`}
                        >
                          {cur}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="p-3 rounded-lg bg-[#09090B] border border-white/10 text-[11px] text-zinc-400 leading-relaxed">
              A sala privada de videochamada só é liberada após a validação financeira oficial via webhook ou captura
              confirmada pelo servidor no gateway escolhido.
            </div>

            <div className="pt-3 border-t border-white/10 flex items-center justify-between">
              <div>
                <div className="text-xs text-zinc-400">Valor contratado</div>
                <div className="text-lg font-semibold font-mono tabular-nums text-[#E5C97B]">
                  {formatMoney(baseEstimateCents, currency)}
                </div>
              </div>
              <button
                type="submit"
                disabled={loading || gateways.length === 0}
                className="px-5 py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] disabled:opacity-50 transition-colors cursor-pointer"
              >
                {loading
                  ? 'Gerando checkout...'
                  : currentGateway
                    ? `Pagar com ${currentGateway.displayName}`
                    : 'Continuar para pagamento'}
              </button>
            </div>
          </form>
        )}

        {step === 'checkout' && checkoutData && (
          <div className="mt-5 space-y-4">
            <div
              className={`p-3.5 rounded-xl border text-xs leading-relaxed ${
                checkoutData.environment === 'production'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              }`}
            >
              <strong>
                {gatewayLabel(checkoutData.gateway)} ·{' '}
                {checkoutData.environment === 'production'
                  ? 'Produção:'
                  : isLocalSandboxMode
                    ? 'Sandbox Local (HMAC):'
                    : 'Sandbox Oficial:'}
              </strong>{' '}
              {checkoutData.pendingNotice}
            </div>

            <div className="p-4 rounded-xl border border-white/10 bg-[#09090B] flex items-center justify-between">
              <div>
                <div className="text-xs text-zinc-400">Total a pagar</div>
                <div className="text-xl font-semibold font-mono tabular-nums text-[#E5C97B]">
                  {formatMoney(checkoutData.amountCents, checkoutData.currency)}
                </div>
              </div>
              <div className="text-right text-xs text-zinc-400 space-y-0.5">
                <div className="text-zinc-200 font-medium">Gateway: {gatewayLabel(checkoutData.gateway)}</div>
                <div>Método: {METHOD_LABELS[paymentMethod]?.label || paymentMethod}</div>
                {checkoutData.providerPaymentId && (
                  <div className="font-mono text-[10px] text-zinc-500">Ref: {checkoutData.providerPaymentId}</div>
                )}
              </div>
            </div>

            {checkoutData.pixQrBase64 && (
              <div className="flex justify-center p-4 rounded-xl bg-white">
                <img
                  src={`data:image/png;base64,${checkoutData.pixQrBase64}`}
                  alt="QR Code PIX Mercado Pago"
                  className="w-44 h-44 object-contain"
                />
              </div>
            )}

            {checkoutData.pixCopyPaste && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-zinc-300">Código PIX Copia e Cola</div>
                <div className="p-3 rounded-lg bg-[#09090B] border border-white/10 font-mono text-[11px] text-zinc-300 break-all">
                  {checkoutData.pixCopyPaste}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(checkoutData.pixCopyPaste || '');
                    setCopiedPix(true);
                    setTimeout(() => setCopiedPix(false), 2000);
                  }}
                  className="inline-flex items-center gap-1.5 text-xs text-[#E5C97B] hover:underline cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copiedPix ? 'Código copiado' : 'Copiar código PIX'}</span>
                </button>
              </div>
            )}

            {!isLocalSandboxMode ? (
              <div className="space-y-2.5">
                {checkoutData.checkoutUrl && (
                  <a
                    href={checkoutData.checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex items-center justify-center gap-2 w-full py-3 rounded-lg text-sm font-semibold ${
                      checkoutData.gateway === 'paypal'
                        ? 'bg-[#0070BA] text-white hover:bg-[#005EA6]'
                        : 'bg-[#D4AF37] text-[#09090B] hover:bg-[#E5C97B]'
                    }`}
                  >
                    <span>Pagar com {gatewayLabel(checkoutData.gateway)}</span>
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleCheckPaymentStatusNow}
                  className="w-full py-2.5 rounded-lg border border-white/15 text-xs text-zinc-200 hover:bg-white/5 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  <span>Verificar confirmação agora</span>
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleSandboxWebhookSimulation('approved')}
                  className="w-full py-3 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {loading
                    ? `Validando webhook ${gatewayLabel(checkoutData.gateway)}...`
                    : `Aprovar no Sandbox ${gatewayLabel(checkoutData.gateway)} (Webhook HMAC)`}
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleSandboxWebhookSimulation('rejected')}
                  className="w-full py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-xs font-medium hover:bg-red-500/15 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  Simular Recusa no {gatewayLabel(checkoutData.gateway)} (Testar Bloqueio)
                </button>
              </div>
            )}

            <button
              type="button"
              disabled={loading}
              onClick={handleCancelAttempt}
              className="w-full py-2 text-xs text-zinc-400 hover:text-white cursor-pointer"
            >
              Cancelar tentativa e escolher outro gateway
            </button>
          </div>
        )}

        {step === 'confirmed' && (
          <div className="mt-6 text-center space-y-4 py-2">
            <div className="w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center mx-auto">
              <Check className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-display text-xl font-semibold text-[#F5F2EB]">
                Pagamento confirmado e sala liberada
              </h3>
              <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                Transação validada via {gatewayLabel(checkoutData?.gateway)}. A comissão, taxas e valor líquido do
                profissional foram lançados no ledger financeiro.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              {confirmedCallId && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    navigate(`/sala/${confirmedCallId}`);
                  }}
                  className="flex-1 py-2.5 px-4 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] cursor-pointer"
                >
                  Entrar na sala privada
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  onClose();
                  navigate('/cliente/agendamentos');
                }}
                className="flex-1 py-2.5 px-4 rounded-lg border border-white/15 text-sm text-zinc-200 hover:bg-white/5 cursor-pointer"
              >
                Ver meus agendamentos
              </button>
            </div>
            <div className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-500 pt-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Acesso restrito exclusivamente ao cliente e profissional autenticados.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
