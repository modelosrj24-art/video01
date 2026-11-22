export function formatBRL(cents: number | null | undefined): string {
  return formatMoney(cents, 'BRL');
}

export function formatMoney(cents: number | null | undefined, currency = 'BRL'): string {
  const value = Number(cents || 0) / 100;
  const normalized = (currency || 'BRL').toUpperCase();
  const locale = normalized === 'USD' ? 'en-US' : normalized === 'EUR' ? 'de-DE' : 'pt-BR';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: normalized,
  }).format(value);
}

export function gatewayLabel(provider: string | null | undefined): string {
  if (!provider) return 'Gateway';
  if (provider === 'paypal') return 'PayPal';
  if (provider === 'mercadopago' || provider === 'mercadopago_sandbox') return 'Mercado Pago';
  return provider;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(d);
}

export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(d);
}

export function formatDurationSeconds(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function availabilityLabel(status: string): { label: string; colorClass: string } {
  switch (status) {
    case 'online':
      return { label: 'Disponível agora', colorClass: 'text-emerald-400' };
    case 'busy':
      return { label: 'Em atendimento', colorClass: 'text-amber-400' };
    default:
      return { label: 'Offline', colorClass: 'text-zinc-500' };
  }
}

export function bookingStatusLabel(status: string): { label: string; colorClass: string } {
  switch (status) {
    case 'aguardando_pagamento':
      return { label: 'Aguardando pagamento', colorClass: 'text-amber-400' };
    case 'pagamento_confirmado':
      return { label: 'Pagamento confirmado', colorClass: 'text-emerald-400' };
    case 'aguardando_profissional':
      return { label: 'Aguardando profissional', colorClass: 'text-amber-400' };
    case 'aguardando_cliente':
      return { label: 'Aguardando cliente', colorClass: 'text-amber-400' };
    case 'em_andamento':
      return { label: 'Em andamento', colorClass: 'text-emerald-400' };
    case 'finalizada':
      return { label: 'Finalizada', colorClass: 'text-zinc-300' };
    case 'cancelada':
      return { label: 'Cancelada', colorClass: 'text-red-400' };
    case 'recusada':
      return { label: 'Recusada', colorClass: 'text-red-400' };
    case 'approved':
      return { label: 'Aprovado', colorClass: 'text-emerald-400' };
    case 'pending':
      return { label: 'Pendente', colorClass: 'text-amber-400' };
    case 'paid':
      return { label: 'Pago', colorClass: 'text-emerald-400' };
    case 'refunded':
      return { label: 'Estornado', colorClass: 'text-red-400' };
    case 'rejected':
      return { label: 'Recusado', colorClass: 'text-red-400' };
    case 'cancelled':
      return { label: 'Cancelado', colorClass: 'text-zinc-400' };
    default:
      return { label: status, colorClass: 'text-zinc-400' };
  }
}

export const DAY_NAMES_PT = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];
